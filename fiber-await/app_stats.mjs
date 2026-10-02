// Sample await-dispatch activity in a running app. See README.md.
//
// From a Meteor shell (or any REPL inside the app process):
//   const s = await import('fibers/fiber-await/app_stats.mjs');
//   s.start();          // ...use the app...
//   s.stop();           // counts and percentages for the window
//   s.measureSwitch();  // optional: fiber switch cost in this process (blocks ~0.1-0.5s)
//
// start() adds a promise `before` hook that counts every promise callback; it costs a JS call per
// promise job while armed, so leave it off when you're not sampling.
import { createRequire } from 'node:module';
import { promiseHooks } from 'node:v8';

// The native fibers module every copy of fibers in the process shares. Read it rather than loading
// fibers_async.js, which would register a dispatcher of its own.
const Fiber = process.fiberLib || createRequire(import.meta.url)('../fibers_sync.js');

let armed = null;

function snapshot() {
  return {
    at: process.hrtime.bigint(),
    drains: Fiber.microtaskDrains,
    drainsWithDispatch: Fiber.drainsWithDispatch,
    dispatched: Fiber.microtasksDispatched,
    redispatches: Fiber.redispatches,
    batched: Fiber.__microtasksBatched || 0,
  };
}

export function start() {
  if (Fiber.microtasksDispatched === undefined || Fiber.redispatches === undefined) {
    throw new Error('this fibers build has no dispatch counters (needs the fiber-await measurement branch)');
  }
  if (armed) armed.stopHook();
  const state = { callbacks: 0 };
  state.stopHook = promiseHooks.onBefore(() => { state.callbacks++; });
  state.start = snapshot();
  armed = state;
  return 'armed';
}

export function stop({ roundTripUs } = {}) {
  if (!armed) throw new Error('call start() first');
  const end = snapshot();
  armed.stopHook();
  const { start: begin, callbacks } = armed;
  armed = null;
  const d = (k) => end[k] - begin[k];
  const pct = (part, whole) => (whole ? `${(100 * part / whole).toFixed(2)}%` : 'n/a');
  const tagged = d('dispatched') + d('batched');
  const untagged = callbacks - tagged;
  const result = {
    seconds: Number(end.at - begin.at) / 1e9,
    promiseCallbacks: callbacks,
    tagged,
    taggedShare: pct(tagged, callbacks),
    untagged,
    // Each redispatch is a gap of untagged callbacks between two tagged ones in the same drain.
    untaggedThatCausedASwitch: d('redispatches'),
    untaggedThatCausedASwitchShare: pct(d('redispatches'), untagged),
    drains: d('drains'),
    drainsWithDispatch: d('drainsWithDispatch'),
    drainsWithDispatchShare: pct(d('drainsWithDispatch'), d('drains')),
    switchesOntoDispatchFiber: d('dispatched'),
    batchedWithoutSwitch: d('batched'),
    batchedShareOfTagged: pct(d('batched'), tagged),
  };
  if (roundTripUs) {
    result.estimatedSwitchMs = Number((d('dispatched') * roundTripUs / 1000).toFixed(1));
    result.estimatedRedispatchMs = Number((d('redispatches') * roundTripUs / 1000).toFixed(1));
  }
  return result;
}

// Cost of one fiber run+yield round trip in this process (the cost of each switch onto the dispatch
// fiber and back). Blocks the event loop while it runs.
export function measureSwitch(n = 5000) {
  const fiber = Fiber(() => { for (;;) Fiber.yield(); });
  fiber.run();
  const begin = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fiber.run();
  return { roundTripUs: Number((Number(process.hrtime.bigint() - begin) / 1e3 / n).toFixed(2)) };
}
