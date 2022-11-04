const { AsyncResource } = require('async_hooks');
const aw = process.binding('async_wrap');
const _Fiber = require('./fibers_sync.js');

const weakMap = new Map();
function Fiber(fn, ...args) {
  if (!(this instanceof Fiber)) {
    return new Fiber(fn, ...args);
  }

  const ar = new AsyncResource('Fiber');

  const actualFn = (...fnArgs) => {
    return ar.runInAsyncScope(() => fn(...fnArgs));
  }
  const _private = {
    _fiber: _Fiber(actualFn, ...args)
  };

  weakMap.set(this, _private);
  _private._fiber._f = this;
  return this;
};

Fiber.__proto__ = _Fiber;
Fiber.prototype = _Fiber.prototype;

Object.defineProperty(Fiber, 'current', {
  get() {
    return _Fiber.current && _Fiber.current._f;
  }
})

_Fiber[Symbol.hasInstance] = function(obj) {
  // hacky
  return obj instanceof Fiber || obj.run;
};

module.exports = Fiber;
Fiber.prototype = {
  __proto__: Fiber,

  get _fiber() {
    return weakMap.get(this)._fiber;
  },

  get started() {
    return this._fiber.started;
  },

  run(...args) {
    return this._fiber.run(...args);
  },

  throwInto(...args) {
    return this._fiber.throwInto(...args);
  },

  reset(...args) {
    return this._fiber.reset(...args);
  }
}
