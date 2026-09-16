"use strict";
// A yielded fiber whose JS object is garbage-collected must be unwound as a zombie, not crash the
// process. On V8 >= 10.4 the weak callback is a phantom (kParameter) callback and has to reset its
// handle; the old kFinalizer code path resurrected the object instead.
var Fiber = require('fibers');
var v8 = require('v8');
var vm = require('vm');
v8.setFlagsFromString('--expose_gc');
var gc = vm.runInNewContext('gc');

var N = 200, unwound = 0;
for (var ii = 0; ii < N; ++ii) {
	var fiber = Fiber(function() {
		try {
			Fiber.yield();
		} catch (err) {
			// zombie exception. Touch Fiber.current: on V8 >= 10.4 the JS object is already gone and
			// this must return undefined instead of dereferencing an empty handle.
			Fiber.current;
			++unwound;
			throw err;
		}
	});
	fiber.run();
	fiber = null;
}
gc(); gc();
Fiber(function() {}).run(); // Fiber::Run() calls DestroyOrphans()
gc(); gc();
Fiber(function() {}).run();

console.log(unwound === N ? 'pass' : 'fail: unwound ' + unwound + '/' + N);
