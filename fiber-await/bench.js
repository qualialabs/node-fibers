// Microbenchmarks for running await continuations on fibers. See README.md.
// Run: node --no-deprecation fiber-await/bench.js            (all)
//      BENCH=switch,io node --no-deprecation fiber-await/bench.js
// Compare the same binary with FIBERS_AWAIT_REUSE=0 or FIBERS_AWAIT_DISPATCH=0, and with stock node.
const path = require('path');
const Fiber = require(path.join(__dirname, '..'));

Fiber.poolSize = 1e9; // production setting; also avoids the pthread coro_destroy crash in test/pool.js

// The fiber code after an await runs on, whether or not Fiber.current shows it.
const runningFiber = () => Fiber.currentIncludingHidden || Fiber.current;
const dispatchAvailable = typeof Fiber.__setMicrotaskDispatcher === 'function';
const now = () => process.hrtime.bigint();
const msSince = (start) => Number(now() - start) / 1e6;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function inFiber(fn) {
  return new Promise((resolve, reject) => Fiber(() => { fn().then(resolve, reject); }).run());
}

function counters() {
  return {
    dispatched: Fiber.microtasksDispatched || 0,
    batched: Fiber.microtasksBatched || 0,
    redispatches: Fiber.redispatches || 0,
  };
}

const benches = {
  // Two fiber switches (run + yield), with fibers' async-hooks stack save/restore. The floor for any
  // design that moves work onto a fiber; works on stock node + fibers.
  async switch() {
    const n = 50000;
    const fiber = Fiber(() => { for (;;) Fiber.yield(); });
    fiber.run();
    const start = now();
    for (let i = 0; i < n; i++) fiber.run();
    return { n, ms: msSince(start), unit: 'run+yield round trip' };
  },

  // A chain of awaits in a fiber with nothing else queued: batching's best case.
  async chain() {
    const n = 100000;
    let ms;
    await inFiber(async () => {
      const start = now();
      for (let i = 0; i < n; i++) await null;
      ms = msSince(start);
    });
    return { n, ms, unit: 'await in a fiber' };
  },

  // Each await resumes from its own macrotask, like a DB call: one dispatch per await.
  async io() {
    const n = 20000;
    let ms;
    await inFiber(async () => {
      const start = now();
      for (let i = 0; i < n; i++) await nextTurn();
      ms = msSince(start);
    });
    return { n, ms, unit: 'I/O-style await in a fiber' };
  },

  // A fibered chain alongside a fiberless one, so tagged and untagged jobs alternate.
  async interleaved() {
    const n = 50000;
    const chain = async () => { for (let i = 0; i < n; i++) await null; };
    const start = now();
    await Promise.all([inFiber(chain), chain()]);
    return { n, ms: msSince(start), unit: 'await in a fiber, interleaved with fiberless' };
  },

  // Awaits in code that never had a fiber: should cost the same as stock.
  async fiberless() {
    const n = 1000000;
    const start = now();
    for (let i = 0; i < n; i++) await null;
    return { n, ms: msSince(start), unit: 'await outside any fiber' };
  },

  // One non-empty microtask drain per macrotask, in fiberless code (znewsham's drain benchmark).
  async drains() {
    const n = 200000;
    const start = now();
    await new Promise((resolve) => {
      let i = 0;
      (function next() {
        if (++i === n) return resolve();
        Promise.resolve().then(() => setImmediate(next));
      })();
    });
    return { n, ms: msSince(start), unit: 'macrotask with a microtask drain' };
  },

  // Park the fiber after an await and resume it from the next macrotask, 1000 at a time.
  async park() {
    if (!dispatchAvailable) return { skipped: 'needs the fiber-await node + fibers' };
    const n = 20000;
    const batch = 1000;
    const start = now();
    for (let i = 0; i < n; i += batch) {
      await Promise.all(Array.from({ length: batch }, () => inFiber(async () => {
        await null;
        const fiber = runningFiber();
        setImmediate(() => fiber.run());
        Fiber.yield();
      })));
    }
    return { n, ms: msSince(start), unit: 'park/resume cycle after await' };
  },
};

(async () => {
  const selected = process.env.BENCH ? process.env.BENCH.split(',') : Object.keys(benches);
  console.log(`node ${process.version}; dispatch API: ${dispatchAvailable}; ` +
    `FIBERS_AWAIT_DISPATCH=${process.env.FIBERS_AWAIT_DISPATCH ?? '(unset)'} ` +
    `FIBERS_AWAIT_REUSE=${process.env.FIBERS_AWAIT_REUSE ?? '(unset)'}`);
  for (const name of selected) {
    await benches[name](); // warm up
    const before = counters();
    const result = await benches[name]();
    const after = counters();
    if (result.skipped) {
      console.log(`${name.padEnd(12)} skipped: ${result.skipped}`);
      continue;
    }
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    const us = (result.ms * 1000 / result.n).toFixed(2);
    console.log(`${name.padEnd(12)} ${us.padStart(8)} us per ${result.unit}` +
      (dispatchAvailable ? `  ${JSON.stringify(delta)}` : ''));
  }
})();
