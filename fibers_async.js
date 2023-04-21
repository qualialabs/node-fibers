const { AsyncResource } = require('async_hooks');
const _Fiber = require('./fibers_sync.js');

const asyncResourceWeakMap = new WeakMap();
function Fiber(fn, ...args) {
  const _fiber = _Fiber(fn, ...args);
  const ar = new AsyncResource('Fiber');
  asyncResourceWeakMap.set(_fiber, ar);
  return _fiber;
};

Fiber.__proto__ = _Fiber;
Fiber.prototype = _Fiber.prototype;

Object.defineProperty(Fiber, 'current', {
  get() {
    return _Fiber.current;
  }
})


_Fiber.prototype.runInAsyncScope = function runInAsyncScope(fn) {
  return asyncResourceWeakMap.get(this).runInAsyncScope(fn);
};

_Fiber[Symbol.hasInstance] = function(obj) {
  // hacky
  return obj instanceof Fiber || obj.run;
};

module.exports = Fiber;
