'use strict';
// Every fiber switch must save the caller's async context (async ids and execution resources),
// run the other fiber on a clean async stack, and restore the caller's context exactly.
// PSEC-2903.
const assert = require('assert');
const { AsyncLocalStorage, AsyncResource, executionAsyncId, executionAsyncResource } = require('async_hooks');
const Fiber = require('fibers');

const aw = process.binding('async_wrap');
function asyncStackSize() {
	return aw.asyncIdStackSize instanceof Function
		? aw.asyncIdStackSize()
		: aw.async_hook_fields[aw.constants.kStackLength];
}

const als = new AsyncLocalStorage();
const topLevelResource = executionAsyncResource();

function snapshot() {
	return {
		resource: executionAsyncResource(),
		id: executionAsyncId(),
		store: als.getStore(),
		depth: asyncStackSize(),
	};
}

function assertSameContext(before, label) {
	const after = snapshot();
	assert.strictEqual(after.resource, before.resource, label + ': executionAsyncResource changed');
	assert.strictEqual(after.id, before.id, label + ': executionAsyncId changed');
	assert.strictEqual(after.store, before.store, label + ': ALS store changed');
	assert.strictEqual(after.depth, before.depth, label + ': async stack depth changed');
}

// Run `fn` as caller C: inside its own AsyncResource scope with its own ALS store.
function asCaller(name, fn) {
	const callerStore = { name };
	return als.run(callerStore, () => new AsyncResource('Caller').runInAsyncScope(fn));
}

// Part 1: ALS stores stay isolated per fiber across yield/resume, and the resumer keeps its context.
function testIsolationAcrossYield() {
	const storeA = { name: 'A' };
	const storeB = { name: 'B' };
	const seen = {};

	const a = Fiber(() => {
		assert.notStrictEqual(executionAsyncResource(), topLevelResource, 'fiber A uses topLevelResource');
		als.run(storeA, () => {
			Fiber.yield();
			seen.aAfterResume = als.getStore();
		});
	});
	const b = Fiber(() => {
		assert.notStrictEqual(executionAsyncResource(), topLevelResource, 'fiber B uses topLevelResource');
		seen.bBeforeRun = als.getStore();
		als.run(storeB, () => {
			Fiber.yield();
			seen.bAfterResume = als.getStore();
		});
	});

	asCaller('C1', () => {
		const before = snapshot();
		a.run();
		assertSameContext(before, 'after a.run (yield)');
		b.run();
		assertSameContext(before, 'after b.run (yield)');
		a.run();
		assertSameContext(before, 'after a.run (finish)');
		b.run();
		assertSameContext(before, 'after b.run (finish)');
		// Creating async resources in the resumer must not throw or crash.
		new AsyncResource('AfterSwitch').emitDestroy();
		Promise.resolve();
	});

	assert.notStrictEqual(seen.bBeforeRun, storeA, 'fiber B saw fiber A\'s store');
	assert.strictEqual(seen.aAfterResume, storeA, 'fiber A lost its store');
	assert.strictEqual(seen.bAfterResume, storeB, 'fiber B lost its store');
}

// Part 2: reset() on a fiber that yielded inside runInAsyncScope leaves the caller unchanged,
// and the fiber's cleanup does not run on top of the caller's async stack.
function testReset() {
	let depthWhileRunning, depthDuringCleanup, storeDuringCleanup;
	const fiberStore = { name: 'F' };
	const f = Fiber(() => {
		new AsyncResource('Inner').runInAsyncScope(() => {
			als.run(fiberStore, () => {
				depthWhileRunning = asyncStackSize();
				try {
					Fiber.yield();
				} finally {
					depthDuringCleanup = asyncStackSize();
					storeDuringCleanup = als.getStore();
				}
			});
		});
	});

	asCaller('C2', () => {
		f.run();
		const before = snapshot();
		f.reset();
		assertSameContext(before, 'after f.reset()');
	});

	assert.strictEqual(storeDuringCleanup, fiberStore, 'fiber cleanup saw the wrong ALS store');
	assert.strictEqual(depthDuringCleanup, depthWhileRunning,
		'fiber cleanup ran on top of the caller\'s async stack (depth ' + depthDuringCleanup +
		', expected ' + depthWhileRunning + ')');
}

// A fiber that yields inside its own AsyncResource scope and ALS store, and records the async
// stack depth while running and during its cleanup.
function makeScopedFiber(onCleanup) {
	const state = { store: { name: 'scoped' } };
	state.fiber = Fiber(() => {
		new AsyncResource('Inner').runInAsyncScope(() => {
			als.run(state.store, () => {
				state.depthWhileRunning = asyncStackSize();
				try {
					Fiber.yield();
				} catch (err) {
					state.caught = err;
				} finally {
					state.depthDuringCleanup = asyncStackSize();
					state.storeDuringCleanup = als.getStore();
					if (onCleanup) onCleanup();
				}
			});
		});
	});
	return state;
}

function assertCleanCleanup(state, label) {
	assert.strictEqual(state.storeDuringCleanup, state.store, label + ': cleanup saw the wrong ALS store');
	assert.strictEqual(state.depthDuringCleanup, state.depthWhileRunning,
		label + ': cleanup ran on top of the caller\'s async stack');
}

// Variant: throwInto() switches into the fiber the same way.
function testThrowInto() {
	const state = makeScopedFiber();
	const err = new Error('thrown into');
	asCaller('C3', () => {
		state.fiber.run();
		const before = snapshot();
		state.fiber.throwInto(err);
		assertSameContext(before, 'after throwInto()');
	});
	assert.strictEqual(state.caught, err, 'fiber did not receive the thrown error');
	assertCleanCleanup(state, 'throwInto');
}

// Variant: a yielded fiber that is garbage collected is unwound later, from the next run().
function testGcOrphanUnwind() {
	require('v8').setFlagsFromString('--expose-gc');
	const gc = require('vm').runInNewContext('gc');
	const result = {};
	(function () {
		const state = makeScopedFiber();
		result.state = { store: state.store };
		state.fiber.run();
		result.state.depthWhileRunning = state.depthWhileRunning;
		// Copy what cleanup records onto `result` without keeping a reference to the fiber.
		const fiberState = state;
		delete state.fiber;
		result.read = () => fiberState;
	})();
	for (let ii = 0; ii < 5 && result.read().depthDuringCleanup === undefined; ++ii) {
		gc();
		asCaller('C4', () => {
			const before = snapshot();
			Fiber(() => {}).run(); // run() unwinds any orphaned fibers first
			assertSameContext(before, 'after run() unwinding an orphan');
		});
	}
	const state = result.read();
	assert.notStrictEqual(state.depthDuringCleanup, undefined, 'orphaned fiber was never unwound');
	assertCleanCleanup(state, 'GC orphan unwind');
}

// reset() keeps its documented behavior.
function testResetBehavior() {
	asCaller('C5', () => {
		const before = snapshot();

		// Not started: returns undefined.
		assert.strictEqual(Fiber(() => {}).reset(), undefined);
		assertSameContext(before, 'after reset() of an unstarted fiber');

		// Running: throws, and the fiber's own context is unchanged afterwards.
		Fiber(() => {
			const inside = snapshot();
			assert.throws(() => Fiber.current.reset(), /not yielding/);
			assertSameContext(inside, 'inside a fiber after a failed reset()');
		}).run();
		assertSameContext(before, 'after a fiber with a failed reset()');

		// Yielded: unwinds and returns without throwing.
		const plain = makeScopedFiber();
		plain.fiber.run();
		plain.fiber.reset();
		assert.notStrictEqual(plain.depthDuringCleanup, undefined, 'reset() did not run the fiber\'s cleanup');
		assertSameContext(before, 'after reset() of a yielded fiber');

		// An error thrown by the fiber's cleanup comes out of reset(), and the caller is restored.
		const throwing = makeScopedFiber(() => { throw new Error('cleanup failed'); });
		throwing.fiber.run();
		assert.throws(() => throwing.fiber.reset(), /cleanup failed/);
		assertSameContext(before, 'after reset() that threw');
	});
}

// On V8 >= 10.4 (Node 20+) collecting a yielded fiber aborts the process ("Handle not reset in
// first callback"), a separate bug fixed by c1d7f99 that this branch does not have yet.
function v8AtLeast(major, minor) {
	const [maj, min] = process.versions.v8.split('.').map(Number);
	return maj > major || (maj === major && min >= minor);
}

testIsolationAcrossYield();
testThrowInto();
if (!v8AtLeast(10, 4)) {
	testGcOrphanUnwind();
}
testResetBehavior();
testReset();
console.log('pass');
