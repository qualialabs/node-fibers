#include "coroutine.h"
#include "v8-version.h"
#include <assert.h>
#include <node.h>
#include <node_version.h>

#include <vector>
#include <iostream>
#include <type_traits>
#include <dlfcn.h>

#define THROW(x, m) return uni::Return(uni::ThrowException(Isolate::GetCurrent(), x(uni::NewLatin1String(Isolate::GetCurrent(), m))), args)

using namespace std;
using namespace v8;

// Qualia: a patched V8 exposes the microtask queue's "checkpoint in progress"
// state (v8::MicrotaskQueue::RunState). Fibers save and restore it on every
// switch so that suspending a fiber in the middle of a checkpoint doesn't
// leave the queue looking busy to everyone else. On a stock V8 this is a no-op.
template <typename Q, typename = void>
struct MicrotaskRunState {
	struct State {};
	static bool Supported() { return false; }
	static State Get(Q*) { return State(); }
	static void Set(Q*, const State&) {}
	static State Park(Q*) { return State(); }
	static bool Idle(Q*) { return true; }
	static size_t Size(Q*) { return 0; }
};

template <typename Q>
struct MicrotaskRunState<Q, std::void_t<typename Q::RunState>> {
	typedef typename Q::RunState State;
	static bool Supported() { return true; }
	static State Get(Q* q) { return q->GetRunState(); }
	static void Set(Q* q, const State& state) { q->SetRunState(state); }
	// State to save for a fiber that is switching out. If it is suspended mid-drain, another stack
	// takes over the queue, so when it resumes its drain loop must stop after the current microtask.
	static State Park(Q* q) {
		State state = q->GetRunState();
		if (state.is_running) {
			state.stop_draining = true;
		}
		return state;
	}
	static bool Idle(Q* q) {
		State state = q->GetRunState();
		return !state.is_running && !state.scope_depth && !state.suppressions;
	}
	static size_t Size(Q* q) { return q->Size(); }
};

typedef MicrotaskRunState<MicrotaskQueue> QueueRunState;
typedef void (*MicrotaskCheckpointHook)(Isolate*, Local<Context>, MicrotaskQueue*);

// Handle legacy V8 API
namespace uni {
#if V8_AT_LEAST(5, 3)
	// Actually 5.2.244
	// ..or maybe actually 5.2.49
	template <void (*F)(void*), class P>
	void WeakCallbackShim(const WeakCallbackInfo<P>& data) {
		F(data.GetParameter());
	}

	template <void (*F)(void*), class T, typename P>
	void MakeWeak(Isolate* isolate, Persistent<T>& handle, P* val) {
		handle.SetWeak(val, WeakCallbackShim<F, P>, WeakCallbackType::kFinalizer);
	}
#elif V8_AT_LEAST(3, 26)
	template <void (*F)(void*), class T, typename P>
	void WeakCallbackShim(const v8::WeakCallbackData<T, P>& data) {
		F(data.GetParameter());
	}

	template <void (*F)(void*), class T, typename P>
	void MakeWeak(Isolate* isolate, Persistent<T>& handle, P* val) {
		handle.SetWeak(val, WeakCallbackShim<F>);
	}
#else
	template <void (*F)(void*)>
	void WeakCallbackShim(Persistent<Value> value, void* data) {
		F(data);
	}
	template <void (*F)(void*), class T, typename P>
	void MakeWeak(Isolate* isolate, Persistent<T>& handle, P* val) {
		handle.MakeWeak(val, WeakCallbackShim<F>);
	}
#endif

#if V8_AT_LEAST(3, 28)
	class TryCatch : public v8::TryCatch {
		public: TryCatch(Isolate* isolate) : v8::TryCatch(isolate) {}
	};
#else
	class TryCatch : public v8::TryCatch {
		public: TryCatch(Isolate* isolate) : v8::TryCatch() {}
	};
#endif

#if V8_AT_LEAST(4, 4)
	Local<String> NewLatin1String(Isolate* isolate, const char* string) {
		return String::NewFromOneByte(isolate, (const uint8_t*)string, NewStringType::kNormal).ToLocalChecked();
	}

	Local<String> NewLatin1Symbol(Isolate* isolate, const char* string) {
		return String::NewFromOneByte(isolate, (const uint8_t*)string, NewStringType::kNormal).ToLocalChecked();
	}
#elif V8_AT_LEAST(3, 26)
	Handle<String> NewLatin1String(Isolate* isolate, const char* string) {
		return String::NewFromOneByte(isolate, (const uint8_t*)string);
	}

	Handle<String> NewLatin1Symbol(Isolate* isolate, const char* string) {
		return String::NewFromOneByte(isolate, (const uint8_t*)string);
	}
#else
	Handle<String> NewLatin1String(Isolate* isolate, const char* string) {
		return String::New(string);
	}

	Handle<String> NewLatin1Symbol(Isolate* isolate, const char* string) {
		return String::NewSymbol(string);
	}
#endif

#if V8_AT_LEAST(4, 4)
	Local<Function> GetFunction(Local<FunctionTemplate> tmpl) {
		return tmpl->GetFunction(Isolate::GetCurrent()->GetCurrentContext()).ToLocalChecked();
	}

	Local<Value> Call(Local<Function> fn, Local<Object> recv, int argc, Local<Value> argv[]) {
		Local<Value> result;
		if (fn->Call(Isolate::GetCurrent()->GetCurrentContext(), recv, argc, argv).ToLocal(&result)) {
			return result;
		} else {
			return {};
		}
	}

	Local<Object> NewInstance(Isolate* isolate, Local<Function> fn, int argc, Local<Value> argv[]) {
		return fn->NewInstance(isolate->GetCurrentContext(), argc, argv).ToLocalChecked();
	}
#else
	Local<Function> GetFunction(Local<FunctionTemplate> tmpl) {
		return tmpl->GetFunction();
	}

	Local<Value> Call(Local<Function> fn, Local<Object> recv, int argc, Local<Value> argv[]) {
		return fn->Call(recv, argc, argv);
	}

	Handle<Object> NewInstance(Isolate* isolate, Local<Function> fn, int argc, Local<Value> argv[]) {
		return fn->NewInstance(argc, argv).ToLocalChecked();
	}
#endif

#if V8_AT_LEAST(4, 4)
	Local<Number> ToNumber(Local<Value> value) {
		return value->ToNumber(Isolate::GetCurrent()->GetCurrentContext()).ToLocalChecked();
	}
#else
	Handle<Number> ToNumber(Local<Value> value) {
		return value->ToNumber();
	}
#endif

#if V8_AT_LEAST(6, 1)
	Local<Value> GetStackTrace(TryCatch* try_catch, Local<Context> context) {
		return try_catch->StackTrace(context).ToLocalChecked();
	}
#else
	Local<Value> GetStackTrace(TryCatch* try_catch, Handle<Context> context) {
		return try_catch->StackTrace();
	}
#endif

// Workaround for v8 issue #1180
// http://code.google.com/p/v8/issues/detail?id=1180
// NOTE: it's not clear if this is still necessary (perhaps Isolate::SetStackLimit could be used?)
#if V8_AT_LEAST(6, 1)
	void fixStackLimit(Isolate* isolate, Local<Context> context) {
		Script::Compile(context, uni::NewLatin1String(isolate, "void 0;")).ToLocalChecked();
	}
#else
	void fixStackLimit(Isolate* isolate, Handle<Context> context) {
		Script::Compile(uni::NewLatin1String(isolate, "void 0;"));
	}
#endif

#if V8_AT_LEAST(3, 26)
	// Node v0.11.13+
	typedef PropertyCallbackInfo<Value> GetterCallbackInfo;
	typedef PropertyCallbackInfo<void> SetterCallbackInfo;
	typedef void FunctionType;
	typedef FunctionCallbackInfo<v8::Value> Arguments;

	class HandleScope {
		v8::HandleScope scope;
		public: HandleScope(Isolate* isolate) : scope(isolate) {}
	};

	template <class T>
	void Reset(Isolate* isolate, Persistent<T>& persistent, Local<T> handle) {
		persistent.Reset(isolate, handle);
	}
	template <class T>
	void Dispose(Isolate* isolate, Persistent<T>& handle) {
		handle.Reset();
	}
	template <class T>
	void ClearWeak(Isolate* isolate, Persistent<T>& handle) {
		handle.ClearWeak(isolate);
	}

	template <class T>
	void SetInternalPointer(Local<T> handle, int index, void* val) {
		handle->SetAlignedPointerInInternalField(index, val);
	}
	template <class T>
	void* GetInternalPointer(Local<T> handle, int index) {
		return handle->GetAlignedPointerFromInternalField(index);
	}

	template <class T>
	Local<T> Deref(Isolate* isolate, Persistent<T>& handle) {
		return Local<T>::New(isolate, handle);
	}

	template <class T>
	void Return(Local<T> handle, const Arguments& args) {
		args.GetReturnValue().Set(handle);
	}
	template <class T>
	void Return(Local<T> handle, GetterCallbackInfo info) {
		info.GetReturnValue().Set(handle);
	}
	template <class T>
	void Return(Persistent<T>& handle, GetterCallbackInfo info) {
		info.GetReturnValue().Set(Local<T>::New(Isolate::GetCurrent(), handle));
	}

	Local<Value> ThrowException(Isolate* isolate, Local<Value> exception) {
		return isolate->ThrowException(exception);
	}

	Local<Context> GetCurrentContext(Isolate* isolate) {
		return isolate->GetCurrentContext();
	}

	Local<Primitive> Undefined(Isolate* isolate) {
		return v8::Undefined(isolate);
	}

	Local<Boolean> NewBoolean(Isolate* isolate, bool value) {
		return Boolean::New(isolate, value);
	}

	Local<Number> NewNumber(Isolate* isolate, double value) {
		return Number::New(isolate, value);
	}

	Local<FunctionTemplate> NewFunctionTemplate(
		Isolate* isolate,
		FunctionCallback callback,
		Local<Value> data = Local<Value>(),
		Local<Signature> signature = Local<Signature>(),
		int length = 0
	) {
		return FunctionTemplate::New(isolate, callback, data, signature, length);
	}

	Local<Signature> NewSignature(
		Isolate* isolate,
		Local<FunctionTemplate> receiver = Local<FunctionTemplate>()
	) {
		return Signature::New(isolate, receiver);
	}

	class ReverseIsolateScope {
		Isolate* isolate;
		public:
			explicit inline ReverseIsolateScope(Isolate* isolate) : isolate(isolate) {
				isolate->Exit();
			}
			inline ~ReverseIsolateScope() {
				isolate->Enter();
			}
	};

	void AdjustAmountOfExternalAllocatedMemory(Isolate* isolate, int64_t change_in_bytes) {
		isolate->AdjustAmountOfExternalAllocatedMemory(change_in_bytes);
	}
#else
	// Node v0.10.x and lower
	typedef AccessorInfo GetterCallbackInfo;
	typedef AccessorInfo SetterCallbackInfo;
	typedef Handle<Value> FunctionType;
	typedef Arguments Arguments;

	class HandleScope {
		v8::HandleScope scope;
		public: HandleScope(Isolate* isolate) {}
	};

	template <class T>
	void Reset(Isolate* isolate, Persistent<T>& persistent, Handle<T> handle) {
		persistent = Persistent<T>::New(handle);
	}
	template <class T>
	void Dispose(Isolate* isolate, Persistent<T>& handle) {
		handle.Dispose();
	}

	template <class T>
	void ClearWeak(Isolate* isolate, Persistent<T>& handle) {
		handle.ClearWeak();
	}

	template <class T>
	void SetInternalPointer(Handle<T> handle, int index, void* val) {
		handle->SetPointerInInternalField(index, val);
	}
	template <class T>
	void* GetInternalPointer(Handle<T> handle, int index) {
		return handle->GetPointerFromInternalField(index);
	}

	template <class T>
	Handle<T> Deref(Isolate* isolate, Persistent<T>& handle) {
		return Local<T>::New(handle);
	}

	Handle<Value> Return(Handle<Value> handle, GetterCallbackInfo info) {
		return handle;
	}

	Handle<Value> Return(Handle<Value> handle, const Arguments& args) {
		return handle;
	}

	Handle<Value> ThrowException(Isolate* isolate, Handle<Value> exception) {
		return ThrowException(exception);
	}

	Handle<Context> GetCurrentContext(Isolate* isolate) {
		return Context::GetCurrent();
	}

	Handle<Primitive> Undefined(Isolate* isolate) {
		return v8::Undefined();
	}

	Handle<Boolean> NewBoolean(Isolate* isolate, bool value) {
		return Boolean::New(value);
	}

	Handle<Number> NewNumber(Isolate* isolate, double value) {
		return Number::New(value);
	}

	Handle<FunctionTemplate> NewFunctionTemplate(
		Isolate* isolate,
		InvocationCallback callback,
		Handle<Value> data = Handle<Value>(),
		Handle<Signature> signature = Handle<Signature>(),
		int length = 0
	) {
		return FunctionTemplate::New(callback, data, signature);
	}

	Handle<Signature> NewSignature(
		Isolate* isolate,
		Handle<FunctionTemplate> receiver = Handle<FunctionTemplate>(),
		int argc = 0,
		Handle<FunctionTemplate> argv[] = 0
	) {
		return Signature::New(receiver, argc, argv);
	}

	class ReverseIsolateScope {
		public: explicit inline ReverseIsolateScope(Isolate* isolate) {}
	};

	void AdjustAmountOfExternalAllocatedMemory(Isolate* isolate, int64_t change_in_bytes) {
		V8::AdjustAmountOfExternalAllocatedMemory(change_in_bytes);
	}
#endif

#if V8_AT_LEAST(6, 1)
	void SetAccessor(
		Isolate* isolate, Local<Object> object, Local<String> name,
		FunctionType (*getter)(Local<String>, const GetterCallbackInfo&),
		void (*setter)(Local<String> property, Local<Value> value, const SetterCallbackInfo&) = 0
	) {
		object->SetAccessor(isolate->GetCurrentContext(), name, (AccessorNameGetterCallback)getter, (AccessorNameSetterCallback)setter).ToChecked();
	}
#elif V8_AT_LEAST(4, 4)
	void SetAccessor(
		Isolate* isolate, Local<Object> object, Local<String> name,
		FunctionType (*getter)(Local<String>, const GetterCallbackInfo&),
		void (*setter)(Local<String> property, Local<Value> value, const SetterCallbackInfo&) = 0
	) {
		object->SetAccessor(isolate->GetCurrentContext(), name, (AccessorNameGetterCallback)getter, (AccessorNameSetterCallback)setter);
	}
#else
	void SetAccessor(
		Isolate* isolate, Local<Object> object, Local<String> name,
		FunctionType (*getter)(Local<String>, const GetterCallbackInfo&),
		void (*setter)(Local<String> property, Local<Value> value, const SetterCallbackInfo&) = 0
	) {
		object->SetAccessor(name, (AccessorNameGetterCallback)getter, (AccessorNameSetterCallback)setter);
	}
#endif

#if V8_AT_LEAST(3, 29)
	// This was actually added in 3.29.67
	void SetStackGuard(Isolate* isolate, void* guard) {
		isolate->SetStackLimit(reinterpret_cast<uintptr_t>(guard));
	}
#elif V8_AT_LEAST(3, 26)
	void SetStackGuard(Isolate* isolate, void* guard) {
		ResourceConstraints constraints;
		constraints.set_stack_limit(reinterpret_cast<uint32_t*>(guard));
		v8::SetResourceConstraints(isolate, &constraints);
	}
#else
	// Extra padding for old versions of v8. Shit's fucked.
	void SetStackGuard(Isolate* isolate, void* guard) {
		ResourceConstraints constraints;
		constraints.set_stack_limit(
			reinterpret_cast<uint32_t*>(guard) + 18 * 1024
		);
		v8::SetResourceConstraints(&constraints);
	}
#endif
}

class Fiber {

	private:
		static Locker* global_locker; // Node does not use locks or threads, so we need a global lock
		static Persistent<FunctionTemplate> tmpl;
		static Persistent<Function> fiber_object;
		static Fiber* current;
		static vector<Fiber*> orphaned_fibers;
		static Persistent<Value> fatal_stack;
		static MicrotaskQueue* microtask_queue;
		static Persistent<Function> microtask_drain;

		Isolate* isolate;
		Persistent<Object> handle;
		Persistent<Function> cb;
		Persistent<Context> v8_context;
		Persistent<Value> zombie_exception;
		Persistent<Value> yielded;
		bool yielded_exception;
		Coroutine* entry_fiber;
		Coroutine* this_fiber;
		bool started;
		bool yielding;
		bool zombie;
		bool resetting;
		QueueRunState::State microtask_state;

		static Fiber& Unwrap(Local<Object> handle) {
			assert(!handle.IsEmpty());
			assert(handle->InternalFieldCount() == 1);
			return *static_cast<Fiber*>(uni::GetInternalPointer(handle, 0));
		}

		Fiber(Local<Object> handle, Local<Function> cb, Local<Context> v8_context) :
			isolate(Isolate::GetCurrent()),
			started(false),
			yielding(false),
			zombie(false),
			resetting(false) {
			uni::Reset(isolate, this->handle, handle);
			uni::Reset(isolate, this->cb, cb);
			uni::Reset(isolate, this->v8_context, v8_context);

			MakeWeak();
			uni::SetInternalPointer(handle, 0, this);
		}

		virtual ~Fiber() {
			assert(!this->started);
			uni::Dispose(isolate, handle);
			uni::Dispose(isolate, cb);
			uni::Dispose(isolate, v8_context);
		}

		/**
		 * Call MakeWeak if it's ok for v8 to garbage collect this Fiber.
		 * i.e. After fiber completes, while yielded, or before started
		 */
		void MakeWeak() {
			uni::MakeWeak<WeakCallback>(isolate, handle, (void*)this);
		}

		/**
		 * And call ClearWeak if it's not ok for v8 to garbage collect this Fiber.
		 * i.e. While running.
		 */
		void ClearWeak() {
			handle.ClearWeak();
		}

		/**
		 * Called when there are no more references to this object in Javascript. If this happens and
		 * the fiber is currently suspended we'll unwind the fiber's stack by throwing exceptions in
		 * order to clear all references.
		 */
		static void WeakCallback(void* data) {
			Fiber& that = *static_cast<Fiber*>(data);
#if !V8_AT_LEAST(7, 4)
			// Deprecated in 0781f42b6
			assert(that.handle.IsNearDeath());
#endif
			assert(current != &that);

			// We'll unwind running fibers later... doing it from the garbage collector is bad news.
			if (that.started) {
				assert(that.yielding);
				orphaned_fibers.push_back(&that);
				that.ClearWeak();
				return;
			}

			delete &that;
		}

		/**
		 * When the v8 garbage collector notifies us about dying fibers instead of unwindng their
		 * stack as soon as possible we put them aside to unwind later. Unwinding from the garbage
		 * collector leads to exponential time garbage collections if there are many orphaned Fibers,
		 * there's also the possibility of running out of stack space. It's generally bad news.
		 *
		 * So instead we have this function to clean up all the fibers after the garbage collection
		 * has finished.
		 */
		static void DestroyOrphans() {
			if (orphaned_fibers.empty()) {
				return;
			}
			vector<Fiber*> orphans(orphaned_fibers);
			orphaned_fibers.clear();

			for (vector<Fiber*>::iterator ii = orphans.begin(); ii != orphans.end(); ++ii) {
				Fiber& that = **ii;
				that.UnwindStack();

				if (that.yielded_exception) {
					// If you throw an exception from a fiber that's being garbage collected there's no way
					// to bubble that exception up to the application.
					auto stack(uni::Deref(that.isolate, fatal_stack));
					cerr <<
						"An exception was thrown from a Fiber which was being garbage collected. This error "
						"can not be gracefully recovered from. The only acceptable behavior is to terminate "
						"this application. The exception appears below:\n\n"
						<<*stack <<"\n";
					exit(1);
				} else {
					uni::Dispose(that.isolate, fatal_stack);
				}

				uni::Dispose(that.isolate, that.yielded);
				that.MakeWeak();
			}
		}

		/**
		 * Instantiate a new Fiber object. When a fiber is created it only grabs a handle to the
		 * callback; it doesn't create any new contexts until run() is called.
		 */
		static uni::FunctionType New(const uni::Arguments& args) {
			if (args.Length() != 1) {
				THROW(Exception::TypeError, "Fiber expects 1 argument");
			} else if (!args[0]->IsFunction()) {
				THROW(Exception::TypeError, "Fiber expects a function");
			} else if (!args.IsConstructCall()) {
				Local<Value> argv[1] = { args[0] };
				return uni::Return(uni::NewInstance(Isolate::GetCurrent(), uni::GetFunction(uni::Deref(Isolate::GetCurrent(), tmpl)), 1, argv), args);
			}

			Local<Function> fn = Local<Function>::Cast(args[0]);
			new Fiber(args.This(), fn, uni::GetCurrentContext(Isolate::GetCurrent()));
			return uni::Return(args.This(), args);
		}

		/**
		 * Begin or resume the current fiber. If the fiber is not currently running a new context will
		 * be created and the callback will start. Otherwise we switch back into the exist context.
		 */
		static uni::FunctionType Run(const uni::Arguments& args) {
			Fiber& that = Unwrap(args.Holder());

			// There seems to be no better place to put this check..
			DestroyOrphans();

			if (that.started && !that.yielding) {
				THROW(Exception::Error, "This Fiber is already running");
			} else if (args.Length() > 1) {
				THROW(Exception::TypeError, "run() excepts 1 or no arguments");
			}

			if (!that.started) {
				// Create a new context with entry point `Fiber::RunFiber()`.
				void** data = new void*[2];
				data[0] = (void*)&args;
				data[1] = &that;
				that.this_fiber = Coroutine::create_fiber((void (*)(void*))RunFiber, data);
				if (!that.this_fiber) {
					delete[] data;
					THROW(Exception::RangeError, "Out of memory");
				}
				that.started = true;
			} else {
				// If the fiber is currently running put the first parameter to `run()` on `yielded`, then
				// the pending call to `yield()` will return that value. `yielded` in this case is just a
				// misnomer, we're just reusing the same handle.
				that.yielded_exception = false;
				if (args.Length()) {
					uni::Reset(that.isolate, that.yielded, args[0]);
				} else {
					uni::Reset<Value>(that.isolate, that.yielded, uni::Undefined(that.isolate));
				}
			}
			that.SwapContext();
			return uni::Return(that.ReturnYielded(), args);
		}

		/**
		 * Throw an exception into a currently yielding fiber.
		 */
		static uni::FunctionType ThrowInto(const uni::Arguments& args) {
			Fiber& that = Unwrap(args.Holder());

			if (!that.yielding) {
				THROW(Exception::Error, "This Fiber is not yielding");
			} else if (args.Length() == 0) {
				uni::Reset<Value>(that.isolate, that.yielded, uni::Undefined(that.isolate));
			} else if (args.Length() == 1) {
				uni::Reset(that.isolate, that.yielded, args[0]);
			} else {
				THROW(Exception::TypeError, "throwInto() expects 1 or no arguments");
			}
			that.yielded_exception = true;
			that.SwapContext();
			return uni::Return(that.ReturnYielded(), args);
		}

		/**
		 * Unwinds a currently running fiber. If the fiber is not running then this function has no
		 * effect.
		 */
		static uni::FunctionType Reset(const uni::Arguments& args) {
			Fiber& that = Unwrap(args.Holder());

			if (!that.started) {
				return uni::Return(uni::Undefined(that.isolate), args);
			} else if (!that.yielding) {
				THROW(Exception::Error, "This Fiber is not yielding");
			} else if (args.Length()) {
				THROW(Exception::TypeError, "reset() expects no arguments");
			}

			that.resetting = true;
			that.UnwindStack();
			that.resetting = false;
			that.MakeWeak();

			Local<Value> val = uni::Deref(that.isolate, that.yielded);
			uni::Dispose(that.isolate, that.yielded);
			if (that.yielded_exception) {
				return uni::Return(uni::ThrowException(that.isolate, val), args);
			} else {
				return uni::Return(val, args);
			}
		}

		/**
		 * Turns the fiber into a zombie and unwinds its whole stack.
		 *
		 * After calling this function you must either destroy this fiber or call MakeWeak() or it will
		 * be leaked.
		 */
		void UnwindStack() {
			assert(!zombie);
			assert(started);
			assert(yielding);
			zombie = true;

			// Setup an exception which will be thrown and rethrown from Fiber::Yield()
			Local<Value> zombie_exception = Exception::Error(uni::NewLatin1String(isolate, "This Fiber is a zombie"));
			uni::Reset(isolate, this->zombie_exception, zombie_exception);
			uni::Reset(isolate, yielded, zombie_exception);
			yielded_exception = true;

			// Swap context back to Fiber::Yield() which will throw an exception to unwind the stack.
			// Futher calls to yield from this fiber will rethrow the same exception.
			SwapContext();
			assert(!started);
			zombie = false;

			// Make sure this is the exception we threw
			if (yielded_exception && yielded == zombie_exception) {
				yielded_exception = false;
				uni::Dispose(isolate, yielded);
				uni::Reset<Value>(isolate, yielded, uni::Undefined(isolate));
			}
			uni::Dispose(isolate, this->zombie_exception);
		}

		/**
		 * Common logic between Run(), ThrowInto(), and UnwindStack(). This is essentially just a
		 * wrapper around this->fiber->() which also handles all the bookkeeping needed.
		 */
		void SwapContext() {

			entry_fiber = &Coroutine::current();
			Fiber* last_fiber = current;
			current = this;

			// The microtask queue's run state belongs to whichever stack is draining it.
			QueueRunState::State outer_microtask_state;
			if (microtask_queue) {
				outer_microtask_state = QueueRunState::Get(microtask_queue);
				QueueRunState::Set(microtask_queue, microtask_state);
			}

			// This will jump into either `RunFiber()` or `Yield()`, depending on if the fiber was
			// already running.
			{
				Unlocker unlocker(isolate);
				uni::ReverseIsolateScope isolate_scope(isolate);
				this_fiber->run();
			}

			// At this point the fiber either returned or called `yield()`.
			if (microtask_queue) {
				microtask_state = QueueRunState::Park(microtask_queue);
				QueueRunState::Set(microtask_queue, outer_microtask_state);
			}
			current = last_fiber;
		}

		/**
		 * Grabs and resets this fiber's yielded value.
		 */
		Local<Value> ReturnYielded() {
			Local<Value> val = uni::Deref(isolate, yielded);
			uni::Dispose(isolate, yielded);
			if (yielded_exception) {
				return uni::ThrowException(isolate, val);
			} else {
				return val;
			}
		}

		/**
		 * This is the entry point for a new fiber, from `run()`.
		 */
		static void RunFiber(void** data) {
			const uni::Arguments* args = (const uni::Arguments*)data[0];
			Fiber& that = *(Fiber*)data[1];
			delete[] data;

			// New C scope so that the stack-allocated objects will be destroyed before calling
			// Coroutine::finish, because that function may not return, in which case the destructors in
			// this function won't be called.
			{
				Locker locker(that.isolate);
				Isolate::Scope isolate_scope(that.isolate);
				uni::HandleScope scope(that.isolate);

				// Set the stack guard for this "thread"; allow 6k of padding past the JS limit for
				// native v8 code to run
				uni::SetStackGuard(that.isolate, reinterpret_cast<char*>(that.this_fiber->bottom()) + 1024 * 6);

				uni::TryCatch try_catch(that.isolate);
				that.ClearWeak();
				Local<Context> v8_context = uni::Deref(that.isolate, that.v8_context);
				v8_context->Enter();

				uni::fixStackLimit(that.isolate, v8_context);

				Local<Value> yielded;
				if (args->Length()) {
					Local<Value> argv[1] = { (*args)[0] };
					yielded = uni::Call(uni::Deref(that.isolate, that.cb), v8_context->Global(), 1, argv);
				} else {
					yielded = uni::Call(uni::Deref(that.isolate, that.cb), v8_context->Global(), 0, NULL);
				}

				if (try_catch.HasCaught()) {
					uni::Reset(that.isolate, that.yielded, try_catch.Exception());
					that.yielded_exception = true;
					if (that.zombie && !that.resetting && !uni::Deref(that.isolate, that.yielded)->StrictEquals(uni::Deref(that.isolate, that.zombie_exception))) {
						// Throwing an exception from a garbage sweep
						uni::Reset(that.isolate, fatal_stack, uni::GetStackTrace(&try_catch, v8_context));
					}
				} else {
					uni::Reset(that.isolate, that.yielded, yielded);
					that.yielded_exception = false;
				}

				// Don't make weak until after notifying the garbage collector. Otherwise it may try and
				// free this very fiber!
				if (!that.zombie) {
					that.MakeWeak();
				}

				// Now safe to leave the context, this stack is done with JS.
				v8_context->Exit();
			}

			// The function returned (instead of yielding).
			that.started = false;
			that.this_fiber->finish(*that.entry_fiber, that.isolate);
		}

		/**
		 * Yield control back to the function that called `run()`. The first parameter to this function
		 * is returned from `run()`. The context is saved, to be later resumed from `run()`.
		 * note: sigh, there is a #define Yield() in WinBase.h on Windows
		 */
		static uni::FunctionType Yield_(const uni::Arguments& args) {
			if (current == NULL) {
				THROW(Exception::Error, "yield() called with no fiber running");
			}

			Fiber& that = *current;

			if (that.zombie) {
				return uni::Return(uni::ThrowException(that.isolate, uni::Deref(that.isolate, that.zombie_exception)), args);
			} else if (args.Length() == 0) {
				uni::Reset<Value>(that.isolate, that.yielded, Undefined(that.isolate));
			} else if (args.Length() == 1) {
				uni::Reset(that.isolate, that.yielded, args[0]);
			} else {
				THROW(Exception::TypeError, "yield() expects 1 or no arguments");
			}
			that.yielded_exception = false;

			// While not running this can be garbage collected if no one has a handle.
			that.MakeWeak();

			// Return control back to `Fiber::run()`. While control is outside this function we mark it as
			// ok to garbage collect. If no one ever has a handle to resume the function it's harmful to
			// keep the handle around.
			{
				Unlocker unlocker(that.isolate);
				uni::ReverseIsolateScope isolate_scope(that.isolate);
				that.yielding = true;
				that.entry_fiber->run();
				that.yielding = false;
			}
			// Now `run()` has been called again.

			// Don't garbage collect anymore!
			that.ClearWeak();

			// Return the yielded value
			return uni::Return(that.ReturnYielded(), args);
		}

		/**
		 * Getters for `started`, and `current`.
		 */
		static uni::FunctionType GetStarted(Local<String> property, const uni::GetterCallbackInfo& info) {
			if (info.This().IsEmpty() || info.This()->InternalFieldCount() != 1) {
				return uni::Return(uni::Undefined(Isolate::GetCurrent()), info);
			}
			Fiber& that = Unwrap(info.This());
			return uni::Return(uni::NewBoolean(that.isolate, that.started), info);
		}

		static uni::FunctionType GetCurrent(Local<String> property, const uni::GetterCallbackInfo& info) {
			if (current) {
				return uni::Return(current->handle, info);
			} else {
				return uni::Return(uni::Undefined(Isolate::GetCurrent()), info);
			}
		}

		/**
		 * Called by a patched node in place of draining the microtask queue. Hands the drain to
		 * the JS function registered with `__setMicrotaskDrain()`, which runs it on a fiber so
		 * that `await` continuations can `Fiber.yield()`.
		 */
		static void MicrotaskCheckpoint(Isolate* isolate, Local<Context> context, MicrotaskQueue* queue) {
			if (queue != microtask_queue || microtask_drain.IsEmpty() || !QueueRunState::Size(queue)) {
				queue->PerformCheckpoint(isolate);
				return;
			}
			if (!QueueRunState::Idle(queue)) {
				// Already draining (or suppressed); PerformCheckpoint would be a no-op too.
				return;
			}
			uni::HandleScope scope(isolate);
			Context::Scope context_scope(context);
			uni::TryCatch try_catch(isolate);
			Local<Function> drain = uni::Deref(isolate, microtask_drain);
			(void)drain->Call(context, context->Global(), 0, NULL);
			if (try_catch.HasTerminated()) {
				return;
			}
			if (try_catch.HasCaught()) {
				// The drain machinery itself failed (microtasks never throw out of a checkpoint).
				String::Utf8Value message(isolate, try_catch.Exception());
				fprintf(stderr, "[fibers] microtask drain failed, draining on the current stack: %s\n", *message ? *message : "<unknown>");
			}
			// Anything left (e.g. after a failure) drains the old way.
			queue->PerformCheckpoint(isolate);
		}

		/**
		 * Fiber.__setMicrotaskDrain(fn): register `fn` as the microtask drain. Returns false if this
		 * node doesn't support it.
		 */
		static uni::FunctionType SetMicrotaskDrain(const uni::Arguments& args) {
			Isolate* isolate = Isolate::GetCurrent();
			if (args.Length() != 1 || !args[0]->IsFunction()) {
				THROW(Exception::TypeError, "__setMicrotaskDrain() expects a function");
			}
			typedef void (*SetHook)(MicrotaskCheckpointHook);
			SetHook set_hook = (SetHook)dlsym(RTLD_DEFAULT, "node_qualia_set_microtask_checkpoint_hook");
			if (!QueueRunState::Supported() || !set_hook) {
				return uni::Return(uni::NewBoolean(isolate, false), args);
			}
			uni::Reset(isolate, microtask_drain, Local<Function>::Cast(args[0]));
			set_hook(MicrotaskCheckpoint);
			return uni::Return(uni::NewBoolean(isolate, true), args);
		}

		/**
		 * Fiber.__runMicrotasks(): drain the microtask queue on the current stack.
		 */
		static uni::FunctionType RunMicrotasks(const uni::Arguments& args) {
			Isolate* isolate = Isolate::GetCurrent();
			if (microtask_queue) {
				microtask_queue->PerformCheckpoint(isolate);
			}
			return uni::Return(uni::Undefined(isolate), args);
		}

		/**
		 * Fiber.__microtaskQueueSize()
		 */
		static uni::FunctionType MicrotaskQueueSize(const uni::Arguments& args) {
			Isolate* isolate = Isolate::GetCurrent();
			size_t size = microtask_queue ? QueueRunState::Size(microtask_queue) : 0;
			return uni::Return(uni::NewNumber(isolate, (double)size), args);
		}

		/**
		 * Allow access to coroutine pool size
		 */
		static uni::FunctionType GetPoolSize(Local<String> property, const uni::GetterCallbackInfo& info) {
			return uni::Return(uni::NewNumber(Isolate::GetCurrent(), Coroutine::pool_size), info);
		}

		static void SetPoolSize(Local<String> property, Local<Value> value, const uni::SetterCallbackInfo& info) {
			Coroutine::pool_size = uni::ToNumber(value)->Value();
		}

		/**
		 * Return number of fibers that have been created
		 */
		static uni::FunctionType GetFibersCreated(Local<String> property, const uni::GetterCallbackInfo& info) {
			return uni::Return(uni::NewNumber(Isolate::GetCurrent(), Coroutine::coroutines_created()), info);
		}

	public:
		/**
		 * Initialize the Fiber library.
		 */
		static void Init(Local<Object> target) {
			// Use a locker which won't get destroyed when this library gets unloaded. This is a hack
			// to prevent v8 from trying to clean up this "thread" while the whole application is
			// shutting down. TODO: There's likely a better way to accomplish this, but since the
			// application is going down lost memory isn't the end of the world. But with a regular lock
			// there's seg faults when node shuts down.
			Isolate* isolate = Isolate::GetCurrent();
			Local<Context> context = isolate->GetCurrentContext();
			global_locker = new Locker(isolate);
			current = NULL;
			if (QueueRunState::Supported()) {
				microtask_queue = context->GetMicrotaskQueue();
			}

			// Fiber constructor
			Local<FunctionTemplate> tmpl = uni::NewFunctionTemplate(isolate, New);
			uni::Reset(isolate, Fiber::tmpl, tmpl);
			tmpl->SetClassName(uni::NewLatin1Symbol(isolate, "Fiber"));

			// Guard which only allows these methods to be called on a fiber; prevents
			// `fiber.run.call({})` from seg faulting.
			Local<Signature> sig = uni::NewSignature(isolate, tmpl);
			tmpl->InstanceTemplate()->SetInternalFieldCount(1);

			// Fiber.prototype
			Local<ObjectTemplate> proto = tmpl->PrototypeTemplate();
			proto->Set(uni::NewLatin1Symbol(isolate, "reset"),
				uni::NewFunctionTemplate(isolate, Reset, Local<Value>(), sig));
			proto->Set(uni::NewLatin1Symbol(isolate, "run"),
				uni::NewFunctionTemplate(isolate, Run, Local<Value>(), sig));
			proto->Set(uni::NewLatin1Symbol(isolate, "throwInto"),
				uni::NewFunctionTemplate(isolate, ThrowInto, Local<Value>(), sig));
			proto->SetAccessor(uni::NewLatin1Symbol(isolate, "started"), GetStarted);

			// Global yield() function
			Local<Function> yield = uni::GetFunction(uni::NewFunctionTemplate(isolate, Yield_));
			Local<String> sym_yield = uni::NewLatin1Symbol(isolate, "yield");
			target->Set(context, sym_yield, yield).FromJust();

			// Fiber properties
			Local<Function> fn = uni::GetFunction(tmpl);
			fn->Set(context, sym_yield, yield).FromJust();
			uni::SetAccessor(isolate, fn, uni::NewLatin1Symbol(isolate, "current"), GetCurrent);
			uni::SetAccessor(isolate, fn, uni::NewLatin1Symbol(isolate, "poolSize"), GetPoolSize, SetPoolSize);
			uni::SetAccessor(isolate, fn, uni::NewLatin1Symbol(isolate, "fibersCreated"), GetFibersCreated);
			fn->Set(context, uni::NewLatin1Symbol(isolate, "__setMicrotaskDrain"),
				uni::GetFunction(uni::NewFunctionTemplate(isolate, SetMicrotaskDrain))).FromJust();
			fn->Set(context, uni::NewLatin1Symbol(isolate, "__runMicrotasks"),
				uni::GetFunction(uni::NewFunctionTemplate(isolate, RunMicrotasks))).FromJust();
			fn->Set(context, uni::NewLatin1Symbol(isolate, "__microtaskQueueSize"),
				uni::GetFunction(uni::NewFunctionTemplate(isolate, MicrotaskQueueSize))).FromJust();

			// Global Fiber
			target->Set(context, uni::NewLatin1Symbol(isolate, "Fiber"), fn).FromJust();
			uni::Reset(isolate, fiber_object, fn);
		}
};

Persistent<FunctionTemplate> Fiber::tmpl;
Persistent<Function> Fiber::fiber_object;
Locker* Fiber::global_locker;
Fiber* Fiber::current = NULL;
vector<Fiber*> Fiber::orphaned_fibers;
Persistent<Value> Fiber::fatal_stack;
MicrotaskQueue* Fiber::microtask_queue = NULL;
Persistent<Function> Fiber::microtask_drain;
bool did_init = false;

#if !NODE_VERSION_AT_LEAST(0,10,0)
extern "C"
#endif
void init(Local<Object> target) {
	Isolate* isolate = Isolate::GetCurrent();
	Local<Context> context = isolate->GetCurrentContext();
	if (did_init || !target->Get(context, uni::NewLatin1Symbol(isolate, "Fiber")).ToLocalChecked()->IsUndefined()) {
		// Oh god. Node will call init() twice even though the library was loaded only once. See Node
		// issue #2621 (no fix).
		return;
	}
	did_init = true;
	uni::HandleScope scope(isolate);
	Coroutine::init(isolate);
	Fiber::Init(target);
	// Default stack size of either 512k or 1M. Perhaps make this configurable by the run time?
	Coroutine::set_stack_size(128 * 1024);
}

NODE_MODULE(fibers, init)
