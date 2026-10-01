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
  const actualFn = (...args1) => ar.runInAsyncScope(() => {
    // _Fiber.current: Fiber.current hides the fibers that run code after an await.
    _Fiber.current._meteor_dynamics = undefined;
    // return the fiber function's value so run() resolves to it when the fiber finishes (fibers README semantics)
    return fn(...args1);
  });
  const _fiber = _Fiber(actualFn, ...args);
  asyncResourceWeakMap.set(_fiber, ar);
  return _fiber;
};

Fiber.__proto__ = _Fiber;
Fiber.prototype = _Fiber.prototype;

// Fibers that run promise reactions (see below) are hidden: `Fiber.current` reports them as
// undefined, exactly what code after an `await` sees today, so `Fiber.current`-based mode switches
// ("in a fiber? return sync, else return a Promise") keep behaving as before. Blocking primitives
// (Future.wait, Promise.await) use `Fiber.currentIncludingHidden` so they can still yield.
const kHidden = Symbol.for('fibers.hiddenAwaitContinuation');

Object.defineProperty(Fiber, 'current', {
  get() {
    const current = _Fiber.current;
    return current && current[kHidden] ? undefined : current;
  }
})

Object.defineProperty(Fiber, 'currentIncludingHidden', {
  get() {
    return _Fiber.current;
  }
})

// poolSize is a native data property on the native constructor. On V8 >= 13 (node 24) assigning
// `Fiber.poolSize = n` on this wrapper no longer reaches that setter: it creates an own property on
// the wrapper and the native pool size silently stays at its default (120). Forward it explicitly,
// which is also what happened implicitly on node 18.
Object.defineProperty(Fiber, 'poolSize', {
  get() {
    return _Fiber.poolSize;
  },
  set(value) {
    _Fiber.poolSize = value;
  },
})


_Fiber.prototype.runInAsyncScope = function runInAsyncScope(fn) {
  return asyncResourceWeakMap.get(this).runInAsyncScope(fn);
};

_Fiber[Symbol.hasInstance] = function(obj) {
  // hacky
  return obj instanceof Fiber || obj.run;
};

// Prototype (Qualia): with a patched node, V8 offers us every promise reaction (e.g. the code after
// an `await`) that was registered inside a fiber. Run it in a new, hidden fiber so it can still
// block. The job's own promise hooks restore its async context inside the fiber.
// FIBERS_AWAIT_DISPATCH=0 turns this off.
if (typeof _Fiber.__setMicrotaskDispatcher === 'function' && process.env.FIBERS_AWAIT_DISPATCH !== '0') {
  _Fiber.__setMicrotaskDispatcher(function dispatchMicrotask(runDispatched, token) {
    const fiber = Fiber(() => runDispatched(token));
    fiber[kHidden] = true;
    fiber.run();
  });
}

module.exports = _Fiber.Fiber = Fiber;
