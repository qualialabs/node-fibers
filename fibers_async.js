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
// an `await`) that was registered inside a fiber. Run it in a hidden fiber so it can still block.
// The job's own promise hooks restore its async context inside the fiber.
// FIBERS_AWAIT_DISPATCH=0 turns this off.
_Fiber.awaitDispatchEnabled = false;
if (typeof _Fiber.__setMicrotaskDispatcher === 'function' && process.env.FIBERS_AWAIT_DISPATCH !== '0'
    && !asyncContextFrameInUse()) {
  _Fiber.awaitDispatchEnabled = true;
  const runNextDispatchable = process.env.FIBERS_AWAIT_REUSE !== '0' ? _Fiber.__runNextDispatchable : undefined;
  _Fiber.__setMicrotaskDispatcher(typeof runNextDispatchable === 'function'
    ? reusingDispatcher(runNextDispatchable)
    : dispatchOnNewFiber);
}

// Node 24's AsyncContextFrame (on by default) keeps AsyncLocalStorage state in the V8 slot we tag
// reactions with, so dispatch needs `--no-async-context-frame` (fibers needs it on node 24 anyway).
// Quiet unless FIBERS_AWAIT_DISPATCH=1 asks for dispatch: helper processes (build tools, child
// processes) load fibers without the flag. Fiber.awaitDispatchEnabled tells you which way it went.
function asyncContextFrameInUse() {
  if (typeof _Fiber.__cpedInUse !== 'function') {
    return false;
  }
  const { AsyncLocalStorage } = require('async_hooks');
  const probe = new AsyncLocalStorage();
  const inUse = probe.run(true, () => _Fiber.__cpedInUse());
  // Without AsyncContextFrame, an AsyncLocalStorage turns on promise hooks for the whole process
  // (every promise pays for them); disabling the probe turns them off again if nothing else uses one.
  probe.disable();
  if (inUse && process.env.FIBERS_AWAIT_DISPATCH === '1') {
    console.warn('[fibers] not running await continuations on fibers: AsyncContextFrame is on (start node with --no-async-context-frame)');
  }
  return inUse;
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
// Kept on the native module, which every copy of this file shares (an app can load more than one).
_Fiber.__microtasksBatched = _Fiber.__microtasksBatched || 0;
function reusingDispatcher(runNextDispatchable) {
  const kIdle = {};
  let dispatchFiber = null;
  let runDispatched;

  function dispatchLoop(token) {
    const self = _Fiber.current;
    for (;;) {
      runDispatched(token);
      // Only while this is still the dispatch fiber, i.e. we're nested inside the microtask loop.
      // A fiber that was parked by a job and later resumed must not pull in unrelated jobs.
      while (self === dispatchFiber && runNextDispatchable()) {
        _Fiber.__microtasksBatched++;
      }
      if (self !== dispatchFiber) {
        return;
      }
      token = _Fiber.yield(kIdle);
    }
  }

  return function dispatchMicrotask(run, token) {
    runDispatched = run;
    if (dispatchFiber && dispatchFiber === _Fiber.current) {
      // A nested microtask drain on the dispatch fiber itself; we can't switch into a running fiber.
      dispatchOnNewFiber(run, token);
      return;
    }
    if (!dispatchFiber) {
      dispatchFiber = Fiber(dispatchLoop);
      dispatchFiber[kHidden] = true;
    }
    const fiber = dispatchFiber;
    if (fiber.run(token) !== kIdle && dispatchFiber === fiber) {
      // A job blocked on this fiber; it belongs to that job now.
      dispatchFiber = null;
    }
  };
}

Object.defineProperty(Fiber, 'microtasksBatched', {
  get() {
    return _Fiber.__microtasksBatched || 0;
  }
})

module.exports = _Fiber.Fiber = Fiber;
