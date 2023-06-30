const { AsyncResource } = require('async_hooks');
const _Fiber = require('./fibers_sync.js');
if (_Fiber.Fiber) {
  // if we were to mix'n'match import/require - we could end up with multiple copies of this
  // it might also relate to weirdness of importing it from inside the shell/debugger
  // it almost looks like the --preserve-symlinks is being ignored in the debugger/shell
  module.exports = _Fiber.Fiber;
}
const asyncResourceWeakMap = new WeakMap();
function Fiber(fn, ...args) {
  const ar = new AsyncResource('Fiber');
  const actualFn = (...args1) => ar.runInAsyncScope(() => fn(...args1));
  const _fiber = _Fiber(actualFn, ...args);
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

module.exports = _Fiber.Fiber = Fiber;
