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
    _Fiber.current._meteor_dynamics = undefined;
    fn(...args1);
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


_Fiber.prototype.runInAsyncScope = function runInAsyncScope(fn) {
  return asyncResourceWeakMap.get(this).runInAsyncScope(fn);
};

_Fiber[Symbol.hasInstance] = function(obj) {
  // hacky
  return obj instanceof Fiber || obj.run;
};

// Prototype (Qualia): with a patched node, V8 offers us every promise reaction (e.g. the code after
// an `await`) that was registered inside a fiber. Run it in a hidden fiber so it can still block.
// The job's own promise hooks restore its async context inside the fiber.
// FIBERS_AWAIT_DISPATCH=0 turns this off.
if (typeof _Fiber.__setMicrotaskDispatcher === 'function' && process.env.FIBERS_AWAIT_DISPATCH !== '0') {
  const runNextDispatchable = process.env.FIBERS_AWAIT_REUSE !== '0' ? _Fiber.__runNextDispatchable : undefined;
  _Fiber.__setMicrotaskDispatcher(typeof runNextDispatchable === 'function'
    ? reusingDispatcher(runNextDispatchable)
    : dispatchOnNewFiber);
}

function dispatchOnNewFiber(runDispatched, token) {
  const fiber = Fiber(() => runDispatched(token));
  fiber[kHidden] = true;
  fiber.run();
}

// Runs jobs on one long-lived hidden fiber instead of a new fiber per job. After each job it keeps
// running the dispatchable jobs queued right behind it, so a run of `await`s in fibered code costs
// one switch onto the fiber and one back, not two per `await`. A job that blocks keeps the fiber
// (it's parked inside that job), and the next dispatch starts a new one. FIBERS_AWAIT_REUSE=0 turns
// this off.
let microtasksBatched = 0;

// The reused fiber runs continuations from unrelated requests one after another. Remove all own
// properties of the fiber after each one, as meteor-promise's fiber pool does before returning a
// fiber to the pool (fiber_pool.js), so nothing a continuation stores on the fiber reaches the next.
// Like the pool, this leaves symbol-keyed properties (including kHidden) in place, and can't help
// code that keys a WeakMap by the fiber: every continuation sees the same fiber object.
function clearOwnProperties(fiber) {
  Object.keys(fiber).forEach(function (key) {
    delete fiber[key];
  });
}

function reusingDispatcher(runNextDispatchable) {
  const kIdle = {};
  let reusableFiber = null;
  let reusableFiberRunning = false;
  let runDispatched;

  function dispatchLoop(token) {
    const self = _Fiber.current;
    for (;;) {
      runDispatched(token);
      clearOwnProperties(self);
      // Only while this is still the reusable fiber, i.e. we're nested inside the microtask loop.
      // A fiber that was parked by a job and later resumed must not pull in unrelated jobs.
      while (self === reusableFiber && runNextDispatchable()) {
        microtasksBatched++;
        clearOwnProperties(self);
      }
      if (self !== reusableFiber) {
        return;
      }
      token = _Fiber.yield(kIdle);
    }
  }

  return function dispatchMicrotask(run, token) {
    runDispatched = run;
    if (reusableFiberRunning) {
      // Defensive: V8 doesn't start a microtask checkpoint during a drain, and the reusable fiber
      // only runs inside one, so this isn't expected. If it happens, the fiber is somewhere on the
      // stack (maybe below another fiber), and we can't switch into it.
      dispatchOnNewFiber(run, token);
      return;
    }
    if (!reusableFiber) {
      reusableFiber = Fiber(dispatchLoop);
      reusableFiber[kHidden] = true;
    }
    const fiber = reusableFiber;
    let result;
    reusableFiberRunning = true;
    try {
      result = fiber.run(token);
    } catch (e) {
      // The fiber died (e.g. it was terminated); start a new one next time.
      reusableFiber = null;
      throw e;
    } finally {
      reusableFiberRunning = false;
    }
    if (result !== kIdle) {
      // A job blocked on this fiber; it belongs to that job now.
      reusableFiber = null;
    }
  };
}

Object.defineProperty(Fiber, 'microtasksBatched', {
  get() {
    return microtasksBatched;
  }
})

module.exports = _Fiber.Fiber = Fiber;
