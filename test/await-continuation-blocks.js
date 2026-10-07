'use strict';
// Fiber.awaitContinuationBlocks counts code after an `await` that blocked on the fiber the
// dispatcher ran it on: once per blocking job, never for jobs that don't block or for awaits made
// outside a fiber. Needs a node with the microtask dispatch patch; elsewhere nothing is dispatched.
var Fiber = require('fibers');
var Future;
try {
	Future = require('fibers/future');
} catch (err) {
	Future = require('future');
}

var enabled = Fiber.awaitDispatchEnabled !== undefined
	? Fiber.awaitDispatchEnabled
	: typeof Fiber.microtasksDispatched === 'number' && process.env.FIBERS_AWAIT_DISPATCH !== '0';
if (!enabled) {
	console.log('pass');
	return;
}

function sleep(ms) {
	var future = new Future();
	setTimeout(function() {
		future.return();
	}, ms);
	return future.wait();
}

function inFiber(fn) {
	return new Promise(function(resolve, reject) {
		Fiber(function() {
			fn().then(resolve, reject);
		}).run();
	});
}

async function blocks(fn) {
	var before = Fiber.awaitContinuationBlocks;
	await fn();
	return Fiber.awaitContinuationBlocks - before;
}

async function main() {
	var cases = [
		['awaits that never block', 0, function() {
			return inFiber(async function() {
				await null;
				await new Promise(function(resolve) {
					setTimeout(resolve, 1);
				});
			});
		}],
		['one continuation blocking twice', 1, function() {
			return inFiber(async function() {
				await null;
				sleep(1);
				sleep(1);
			});
		}],
		['two continuations that block', 2, function() {
			return inFiber(async function() {
				await null;
				sleep(1);
				await null;
				sleep(1);
			});
		}],
		['awaits outside a fiber', 0, async function() {
			await null;
			await new Promise(function(resolve) {
				setTimeout(resolve, 1);
			});
		}],
	];
	for (var ii = 0; ii < cases.length; ii++) {
		var got = await blocks(cases[ii][2]);
		if (got !== cases[ii][1]) {
			throw new Error(cases[ii][0] + ': expected ' + cases[ii][1] + ' blocks, counted ' + got);
		}
	}
	console.log('pass');
}

main().catch(function(err) {
	console.log(err.stack);
});
