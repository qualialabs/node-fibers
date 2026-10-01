// ~/dev/node/out/Release/node --expose-gc bench-microtask-fibers.js
// and again with FIBERS_DISABLE_MICROTASK_FIBERS=1 to compare.
const Fiber = require('./fibers');

// One non-empty microtask drain per macrotask: the per-drain cost of switching onto a drain fiber.
function drainsPerMacrotask(n) {
  return new Promise(resolve => {
    let i = 0;
    const start = process.hrtime.bigint();
    (function next() {
      if (++i === n) return resolve(Number(process.hrtime.bigint() - start) / 1e6);
      Promise.resolve().then(() => setImmediate(next));
    })();
  });
}

// Yield/resume after await, in batches, reporting RSS and heap after each round.
async function parkCycles(rounds, perRound) {
  if (!Fiber.microtaskFibers) return;
  for (let r = 0; r < rounds; r++) {
    await Promise.all(Array.from({ length: perRound }, () => new Promise(resolve => {
      Fiber(async () => {
        await null;
        const fiber = Fiber.current;
        setImmediate(() => fiber.run());
        Fiber.yield();
        resolve();
      }).run();
    })));
    global.gc();
    const { rss, heapUsed } = process.memoryUsage();
    console.log(`  round ${r}: rss ${(rss / 1e6).toFixed(0)}MB heap ${(heapUsed / 1e6).toFixed(0)}MB`);
  }
}

(async () => {
  console.log(`microtaskFibers enabled: ${!!Fiber.microtaskFibers}`);
  await drainsPerMacrotask(10000); // warm up
  const ms = await drainsPerMacrotask(200000);
  console.log(`200k macrotasks, each with a microtask drain: ${ms.toFixed(0)}ms (${(ms * 1000 / 200000).toFixed(2)}us each)`);
  await parkCycles(5, 50000);
})();
