#include "coroutine.h"
#include "v8-version.h"
#include <assert.h>
#ifndef WINDOWS
#include <pthread.h>
#else
#include <windows.h>
#include <intrin.h>
// Stub pthreads into Windows approximations
#define pthread_t HANDLE
#define pthread_create(thread, attr, fn, arg) !((*thread)=CreateThread(NULL, 0, &(fn), arg, 0, NULL))
#define pthread_join(thread, arg) WaitForSingleObject((thread), INFINITE)
#define pthread_key_t DWORD
#define pthread_key_create(key, dtor) (*key)=TlsAlloc()
#define pthread_setspecific(key, val) TlsSetValue((key), (val))
#define pthread_getspecific(key) TlsGetValue((key))
#endif

#include <stdexcept>
#include <cstdio>
#include <cstdlib>
#ifndef WINDOWS
#include <dlfcn.h>
#endif
#include <stack>
#include <vector>
using namespace std;

const size_t v8_tls_keys = 3;
static std::vector<void*> fls_data_pool;
static pthread_key_t coro_thread_key = 0;
static pthread_key_t isolate_key = 0x7777;
static pthread_key_t thread_id_key = 0x7777;
static pthread_key_t thread_data_key = 0x7777;

/**
 * Qualia's node build exports `v8_qualia_set_thread_stack_start(void*)`. V8 >= 12 records the
 * start of the OS thread's stack when an isolate is entered and cppgc conservatively scans from
 * the current stack pointer up to it during GC; on a coroutine stack that range is garbage. When
 * the symbol exists we tell V8 which stack is running on every switch (nullptr = the thread's own
 * stack). Resolved with dlsym so this addon still loads on a node without the patch.
 */
typedef void (*set_thread_stack_start_t)(void*);
static set_thread_stack_start_t set_thread_stack_start = NULL;

static void notify_stack_start(const Coroutine& next);

static size_t stack_size = 0;
static size_t coroutines_created_ = 0;
static vector<Coroutine*> fiber_pool;
static Coroutine* delete_me = NULL;
size_t Coroutine::pool_size = 120;

static bool can_poke(void* addr) {
#ifdef WINDOWS
	MEMORY_BASIC_INFORMATION mbi;
	if (!VirtualQueryEx(GetCurrentProcess(), addr, &mbi, sizeof(mbi))) {
		return false;
	}
	if (!(mbi.State & MEM_COMMIT)) {
		return false;
	}
	return true;
#else
	// TODO?
	return addr > (void*)0x1000;
#endif
}

#ifdef USE_V8_SYMBOLS
// ** This no longer works as of v8 7.3.262; `thread_id_key_` moved to a static variable inside a
// function in an anonymous namespace.

// Some distributions of node, most notably Ubuntu, strip the v8 internal symbols and so we don't
// have access to this stuff. In most cases we will use the more complicated `find_thread_id_key`
// below, since it tends to work on more platforms.
namespace v8 {
	namespace base {
		class Thread {
			public: typedef int32_t LocalStorageKey;
		};
	}

	namespace internal {
		class Isolate {
			public:
				static base::Thread::LocalStorageKey isolate_key_;
				static base::Thread::LocalStorageKey per_isolate_thread_data_key_;
				static base::Thread::LocalStorageKey thread_id_key_;
		};
	}
}
#endif

struct tls_snapshot_t {
	v8::Isolate* isolate;
	std::vector<void*> values;
};

/**
 * Runs on a fresh helper thread: enter the isolate (which makes V8 assign this thread a new
 * ThreadId and thread data) and copy every pthread TLS slot below `coro_thread_key`.
 */
#ifndef WINDOWS
static void* snapshot_tls(void* arg)
#else
static DWORD __stdcall snapshot_tls(LPVOID arg)
#endif
{
	tls_snapshot_t* snap = static_cast<tls_snapshot_t*>(arg);
	assert(snap->isolate != NULL);
	v8::Locker locker(snap->isolate);
	snap->isolate->Enter();
#ifdef __MUSL__
	// 128 is default max key in musl
	const pthread_key_t key_count = 128;
#else
	const pthread_key_t key_count = coro_thread_key;
#endif
	snap->values.assign(key_count, NULL);
	for (pthread_key_t ii = 0; ii < key_count; ++ii) {
		snap->values[ii] = pthread_getspecific(ii);
	}
	snap->isolate->Exit();
	return NULL;
}

static void take_tls_snapshot(v8::Isolate* isolate, tls_snapshot_t& snap) {
	snap.isolate = isolate;
	pthread_t thread;
	pthread_create(&thread, NULL, snapshot_tls, &snap);
	pthread_join(thread, NULL);
}

/**
 * Locate the pthread TLS keys V8 uses for the current isolate, per-isolate thread data and
 * ThreadId. Up to V8 12 all three were pthread keys and can be found by value (the isolate
 * pointer, a struct whose first word is the isolate pointer, and the int thread id read from
 * that struct). Newer V8 keeps the isolate and thread data in compiler thread_local storage
 * (which Locker/Unlocker maintain for us), so only the ThreadId key matters: it is the slot
 * holding a small positive int that increments between two consecutively created threads.
 */
static void find_thread_id_key(v8::Isolate* isolate) {
	tls_snapshot_t a;
	take_tls_snapshot(isolate, a);
	const pthread_key_t key_count = a.values.size();

	// First pass-- find isolate thread key
	for (pthread_key_t ii = key_count; ii > 0; --ii) {
		if (a.values[ii - 1] == isolate) {
			isolate_key = ii - 1;
			break;
		}
	}

	// Second pass-- find data key
	int thread_id = 0;
	if (isolate_key != 0x7777) {
		for (pthread_key_t ii = isolate_key + 1; ii < key_count; ++ii) {
			void* tls = a.values[ii];
			if (can_poke(tls) && *(void**)tls == isolate) {
				// First member of per-thread data is the isolate
				thread_data_key = ii;
				// Second member is the thread id
				thread_id = *(int*)((void**)tls + 1);
				break;
			}
		}
	}

	// Third pass-- find thread id key
	if (thread_data_key != 0x7777) {
		for (pthread_key_t ii = isolate_key + 1; ii < key_count; ++ii) {
			int tls = static_cast<int>(reinterpret_cast<intptr_t>(a.values[ii]));
			if (tls == thread_id) {
				thread_id_key = ii;
				break;
			}
		}
	}

	if (thread_id_key == 0x7777) {
		// Fallback for V8 >= 13: compare against further helper threads. V8 hands out thread ids
		// from an atomic counter, so the ThreadId slot is the one whose small positive value grows
		// between two consecutively created threads. Other threads (V8 platform workers) may be
		// created concurrently and consume ids, so allow a small gap, require the match to be
		// unique, and retry with a fresh snapshot pair when it is not.
		for (int attempt = 0; attempt < 8 && thread_id_key == 0x7777; ++attempt) {
			tls_snapshot_t b;
			take_tls_snapshot(isolate, b);
			pthread_key_t candidate = 0x7777;
			int candidates = 0;
			for (pthread_key_t ii = 0; ii < key_count && ii < b.values.size(); ++ii) {
				intptr_t va = reinterpret_cast<intptr_t>(a.values[ii]);
				intptr_t vb = reinterpret_cast<intptr_t>(b.values[ii]);
				if (va > 0 && va < (1 << 24) && vb > va && vb - va <= 64) {
					candidate = ii;
					++candidates;
				}
			}
			if (candidates == 1) {
				thread_id_key = candidate;
			}
			a = b;
		}
	}
	if (thread_id_key == 0x7777) {
		// Without this key every coroutine shares the OS thread's V8 ThreadId and Locker/Unlocker
		// archiving silently corrupts JS stacks. Refuse to run rather than fail intermittently
		// later (an assert would be compiled out of Release builds).
		fprintf(stderr, "fibers: could not locate V8's ThreadId thread-local key; this node/V8 build is not supported (set FIBERS_DEBUG_TLS=1 for details)\n");
		abort();
	}
	if (getenv("FIBERS_DEBUG_TLS")) {
		fprintf(stderr, "fibers: v8 tls keys isolate=%d thread_data=%d thread_id=%d (0x7777 = not found)\n",
			(int)isolate_key, (int)thread_data_key, (int)thread_id_key);
	}
}

/**
 * Coroutine class definition
 */
void Coroutine::init(v8::Isolate* isolate) {
	v8::Unlocker unlocker(isolate);
	pthread_key_create(&coro_thread_key, NULL);
	pthread_setspecific(coro_thread_key, &current());
#ifdef USE_V8_SYMBOLS
	isolate_key = v8::internal::Isolate::isolate_key_;
	thread_data_key = v8::internal::Isolate::per_isolate_thread_data_key_;
	thread_id_key = v8::internal::Isolate::thread_id_key_;
#elif !defined(CORO_PTHREAD)
	find_thread_id_key(isolate);
#endif
#if !defined(WINDOWS) && !defined(CORO_PTHREAD)
	set_thread_stack_start = reinterpret_cast<set_thread_stack_start_t>(dlsym(RTLD_DEFAULT, "v8_qualia_set_thread_stack_start"));
	if (getenv("FIBERS_DEBUG_TLS")) {
		fprintf(stderr, "fibers: v8_qualia_set_thread_stack_start %s\n", set_thread_stack_start ? "found" : "not found (GC may scan the wrong stack)");
	}
#endif
}

Coroutine& Coroutine::current() {
	Coroutine* current = static_cast<Coroutine*>(pthread_getspecific(coro_thread_key));
	if (!current) {
		current = new Coroutine;
		pthread_setspecific(coro_thread_key, current);
	}
	return *current;
}

void Coroutine::set_stack_size(unsigned int size) {
	assert(!stack_size);
	stack_size = size;
}

size_t Coroutine::coroutines_created() {
	return coroutines_created_;
}

void Coroutine::trampoline(void* that) {
#ifdef CORO_PTHREAD
	pthread_setspecific(coro_thread_key, that);
#endif
#ifdef CORO_FIBER
	// I can't figure out how to get the precise base of the stack in Windows. Since CreateFiber
	// creates the stack automatically we don't have access to the base. We can however grab the
	// current esp position, and use that as an approximation. Padding is added for safety since the
	// base is slightly different.
	static_cast<Coroutine*>(that)->stack_base = (size_t*)_AddressOfReturnAddress() - stack_size + 16;
#endif
	if (!fls_data_pool.empty()) {
		pthread_setspecific(thread_data_key, fls_data_pool.back());
		pthread_setspecific(thread_id_key, fls_data_pool[fls_data_pool.size() - 2]);
		pthread_setspecific(isolate_key, fls_data_pool[fls_data_pool.size() - 3]);
		fls_data_pool.resize(fls_data_pool.size() - 3);
	}
	while (true) {
		static_cast<Coroutine*>(that)->entry(const_cast<void*>(static_cast<Coroutine*>(that)->arg));
	}
}

Coroutine::Coroutine() :
	fls_data(v8_tls_keys),
	entry(NULL),
	arg(NULL) {
	stack.sptr = NULL;
	coro_create(&context, NULL, NULL, NULL, 0);
}

Coroutine::Coroutine(entry_t& entry, void* arg) :
	fls_data(v8_tls_keys),
	entry(entry),
	arg(arg) {
}

Coroutine::~Coroutine() {
	if (stack.sptr) {
		coro_stack_free(&stack);
	}
#ifdef CORO_FIBER
	if (context.fiber)
#endif
	(void)coro_destroy(&context);
}

Coroutine* Coroutine::create_fiber(entry_t* entry, void* arg) {
	if (!fiber_pool.empty()) {
		Coroutine* fiber = fiber_pool.back();
		fiber_pool.pop_back();
		fiber->reset(entry, arg);
		return fiber;
	}
	Coroutine* coro = new Coroutine(*entry, arg);
	if (!coro_stack_alloc(&coro->stack, stack_size)) {
		delete coro;
		return NULL;
	}
	coro_create(&coro->context, trampoline, coro, coro->stack.sptr, coro->stack.ssze);
#ifdef CORO_FIBER
	// Stupid hack. libcoro's project structure combined with Windows's CreateFiber functions makes
	// it difficult to catch this error. Sometimes Windows will return `ERROR_NOT_ENOUGH_MEMORY` or
	// `ERROR_COMMITMENT_LIMIT` if it can't make any more fibers. However, `coro_stack_alloc` returns
	// success unconditionally on Windows so we have to detect the error here, after the call to
	// `coro_create`.
	if (!coro->context.fiber) {
		delete coro;
		return NULL;
	}
#endif
	++coroutines_created_;
	return coro;
}

void Coroutine::reset(entry_t* entry, void* arg) {
	assert(entry != NULL);
	this->entry = entry;
	this->arg = arg;
}

static void notify_stack_start(const Coroutine& next) {
	if (!set_thread_stack_start) {
		return;
	}
	void* bottom = next.bottom();
	// The original thread's Coroutine has no stack of its own: fall back to the OS thread's stack.
	set_thread_stack_start(bottom ? static_cast<char*>(bottom) + next.stack_bytes() : NULL);
}

void Coroutine::transfer(Coroutine& next) {
	assert(this != &next);
#ifndef CORO_PTHREAD
	// Keys V8 no longer keeps in pthread TLS stay at 0x7777 and are skipped.
	if (isolate_key != 0x7777) {
		fls_data[0] = pthread_getspecific(isolate_key);
		pthread_setspecific(isolate_key, next.fls_data[0]);
	}
	if (thread_id_key != 0x7777) {
		fls_data[1] = pthread_getspecific(thread_id_key);
		pthread_setspecific(thread_id_key, next.fls_data[1]);
	}
	if (thread_data_key != 0x7777) {
		fls_data[2] = pthread_getspecific(thread_data_key);
		pthread_setspecific(thread_data_key, next.fls_data[2]);
	}

	pthread_setspecific(coro_thread_key, &next);
	notify_stack_start(next);
#endif
	coro_transfer(&context, &next.context);
#ifndef CORO_PTHREAD
	pthread_setspecific(coro_thread_key, this);
#endif
}

void Coroutine::run() {
	Coroutine& current = Coroutine::current();
	assert(!delete_me);
	assert(&current != this);
	current.transfer(*this);

	if (delete_me) {
		// This means finish() was called on the coroutine and the pool was full so this coroutine needs
		// to be deleted. We can't delete from inside finish(), because that would deallocate the
		// current stack. However we CAN delete here, we just have to be very careful.
		assert(delete_me == this);
		assert(&current != this);
		delete_me = NULL;
		delete this;
	}
}

void Coroutine::finish(Coroutine& next, v8::Isolate* isolate) {
	{
		assert(&next != this);
		assert(&current() == this);
		if (fiber_pool.size() < pool_size) {
			fiber_pool.push_back(this);
		} else {
#if V8_MAJOR_VERSION > 4 || (V8_MAJOR_VERSION == 4 && V8_MINOR_VERSION >= 10)
			// Clean up isolate data
			isolate->DiscardThreadSpecificMetadata();
#else
			// If not supported, then we can mitigate v8's leakage by saving these thread locals.
			fls_data_pool.reserve(fls_data_pool.size() + 3);
			fls_data_pool.push_back(pthread_getspecific(isolate_key));
			fls_data_pool.push_back(pthread_getspecific(thread_id_key));
			fls_data_pool.push_back(pthread_getspecific(thread_data_key));
#endif
			// Can't delete right now because we're currently on this stack!
			assert(delete_me == NULL);
			delete_me = this;
		}
	}
	this->transfer(next);
}

void* Coroutine::bottom() const {
#ifdef CORO_FIBER
	return stack_base;
#else
	return stack.sptr;
#endif
}

size_t Coroutine::stack_bytes() const {
#ifdef CORO_FIBER
	return stack_size * sizeof(void*);
#else
	return stack.ssze;
#endif
}

size_t Coroutine::size() const {
	return sizeof(Coroutine) + stack_size * sizeof(void*);
}
