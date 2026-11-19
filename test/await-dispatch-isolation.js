'use strict';
// State stored on the reused await dispatch fiber must not reach the next request's continuation.
// Each "request" is a fiber that awaits; the code after its `await` runs on the shared hidden
// dispatch fiber (Fiber.currentIncludingHidden). Needs the patched node; passes trivially without
// it, or with FIBERS_AWAIT_DISPATCH=0 / FIBERS_AWAIT_REUSE=0 (no shared fiber).
const assert = require('assert');
const Fiber = require('fibers');
const Future = require('future');

const tick = () => Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(handler) {
	return new Promise((resolve, reject) => {
		Fiber(() => {
			handler().then(resolve, reject);
		}).run();
	});
}

function block(ms) {
	const future = new Future();
	setTimeout(() => future.return(), ms);
	future.wait();
}

async function main() {
	const sharedFiber = await request(async () => {
		await tick();
		const first = Fiber.currentIncludingHidden;
		await tick();
		return first && first === Fiber.currentIncludingHidden ? first : null;
	});
	if (!sharedFiber) {
		console.log('pass');
		return;
	}

	// K1: a string-keyed property set by one request is gone when the next continuation runs,
	// both when the two are batched together and when the next request comes later.
	let bobSaw;
	await Promise.all([
		request(async () => {
			await tick();
			Fiber.currentIncludingHidden.currentUser = 'alice';
		}),
		request(async () => {
			await tick();
			await tick();
			bobSaw = Fiber.currentIncludingHidden.currentUser;
		}),
	]);
	assert.strictEqual(bobSaw, undefined, 'batched continuation saw the previous one\'s property');
	const carolSaw = await request(async () => {
		await tick();
		return Fiber.currentIncludingHidden.currentUser;
	});
	assert.strictEqual(carolSaw, undefined, 'later continuation saw an earlier one\'s property');

	// Clearing keeps the fiber hidden.
	const hidden = await request(async () => {
		await tick();
		return Fiber.current === undefined && Fiber.currentIncludingHidden !== undefined;
	});
	assert.ok(hidden, 'dispatch fiber is no longer hidden after clearing');

	// A continuation that blocks keeps its fiber, so its properties never reach anyone else.
	let erinSaw;
	await Promise.all([
		request(async () => {
			await tick();
			Fiber.currentIncludingHidden.currentUser = 'dave';
			block(10);
		}),
		request(async () => {
			await tick();
			await sleep(2);
			erinSaw = Fiber.currentIncludingHidden.currentUser;
		}),
	]);
	assert.strictEqual(erinSaw, undefined, 'continuation saw the property of one that blocked');
	await sleep(20);
	const frankSaw = await request(async () => {
		await tick();
		return Fiber.currentIncludingHidden.currentUser;
	});
	assert.strictEqual(frankSaw, undefined, 'continuation saw the property of one that blocked and finished');

	// K3 (known limitation, same as meteor-promise's pool): symbol-keyed properties survive.
	const sym = Symbol('currentUser');
	let symbolSaw;
	await Promise.all([
		request(async () => {
			await tick();
			Fiber.currentIncludingHidden[sym] = 'alice';
		}),
		request(async () => {
			await tick();
			await tick();
			symbolSaw = Fiber.currentIncludingHidden[sym];
			delete Fiber.currentIncludingHidden[sym];
		}),
	]);
	assert.strictEqual(symbolSaw, 'alice', 'symbol-keyed properties are expected to survive, like meteor-promise\'s pool');

	// K2 (known limitation): every continuation sees the same fiber object, so a WeakMap keyed by
	// it is shared. No clearing can fix identity.
	const byFiber = new WeakMap();
	let weakMapSaw;
	await Promise.all([
		request(async () => {
			await tick();
			byFiber.set(Fiber.currentIncludingHidden, 'alice');
		}),
		request(async () => {
			await tick();
			await tick();
			weakMapSaw = byFiber.get(Fiber.currentIncludingHidden);
		}),
	]);
	assert.strictEqual(weakMapSaw, 'alice', 'continuations are expected to share the dispatch fiber\'s identity');

	console.log('pass');
}

main().catch((err) => {
	console.error(err.stack);
	process.exit(1);
});
