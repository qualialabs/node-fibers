// Run with the patched node:  ~/dev/node/out/Release/node test-microtask-fibers.js
// Compare against stock behaviour with FIBERS_DISABLE_MICROTASK_FIBERS=1.
const assert = require('assert');
const { AsyncLocalStorage } = require('async_hooks');
const Fiber = require('./fibers');
const Future = require('./future');

const als = new AsyncLocalStorage();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What Meteor's Promise.await does: park the current fiber until the promise settles.
function fiberAwait(promise) {
  const fiber = Fiber.current;
  if (!fiber) throw new Error('fiberAwait: no fiber');
  promise.then(value => fiber.run(value), error => fiber.throwInto(error));
  return Fiber.yield();
}

function fiberSleep(ms) {
  const fiber = Fiber.current;
  setTimeout(() => fiber.run(), ms);
  Fiber.yield();
}

const tests = {
  async 'Fiber.yield after await resumes with the value passed to run()'() {
    let result;
    const done = new Promise(resolve => {
      Fiber(async () => {
        await null;
        const fiber = Fiber.current;
        setTimeout(() => fiber.run(42), 5);
        result = Fiber.yield();
        resolve();
      }).run();
    });
    await done;
    assert.strictEqual(result, 42);
  },

  async 'Promise.await-style wait after await (used to deadlock)'() {
    const value = await new Promise((resolve, reject) => {
      Fiber(async () => {
        try {
          await sleep(1);
          resolve(fiberAwait(sleep(5).then(() => 'ok')));
        } catch (e) { reject(e); }
      }).run();
    });
    assert.strictEqual(value, 'ok');
  },

  async 'Future.wait after await'() {
    const value = await new Promise((resolve, reject) => {
      Fiber(async () => {
        try {
          await null;
          const future = new Future();
          setTimeout(() => future.return('future'), 5);
          resolve(future.wait());
        } catch (e) { reject(e); }
      }).run();
    });
    assert.strictEqual(value, 'future');
  },

  async 'AsyncLocalStorage context survives the yield'() {
    const seen = await new Promise((resolve, reject) => {
      als.run({ id: 'outer' }, () => {
        Fiber(async () => {
          try {
            await null;
            const before = als.getStore()?.id;
            fiberSleep(5);
            const after = als.getStore()?.id;
            await null;
            resolve([before, after, als.getStore()?.id]);
          } catch (e) { reject(e); }
        }).run();
      });
    });
    assert.deepStrictEqual(seen, ['outer', 'outer', 'outer']);
  },

  async 'a parked microtask does not stall other promises'() {
    const parked = new Promise(resolve => {
      Fiber(async () => {
        await null;
        fiberSleep(200);
        resolve();
      }).run();
    });
    const start = Date.now();
    await sleep(1);
    await Promise.resolve();
    const elapsed = Date.now() - start;
    assert(elapsed < 100, `other promises waited ${elapsed}ms behind the parked fiber`);
    await parked;
  },

  async 'resuming a parked fiber does not drain unrelated microtasks mid-callback'() {
    let fiber;
    const parked = new Promise(resolve => {
      Fiber(async () => {
        await null;
        fiber = Fiber.current;
        Fiber.yield();
        resolve();
      }).run();
    });
    await sleep(1);
    const ranEarly = await new Promise(resolve => setTimeout(() => {
      let syncDone = false;
      let early = null;
      Promise.resolve().then(() => { early = !syncDone; });
      fiber.run();
      syncDone = true;
      setTimeout(() => resolve(early), 1);
    }, 1));
    assert.strictEqual(ranEarly, false, 'a microtask ran before the callback that queued it returned');
    await parked;
  },

  async 'many concurrent parked fibers interleave correctly'() {
    const order = [];
    await Promise.all([30, 10, 20].map(ms => new Promise(resolve => {
      Fiber(async () => {
        await null;
        fiberSleep(ms);
        order.push(ms);
        await null;
        fiberSleep(1);
        resolve();
      }).run();
    })));
    assert.deepStrictEqual(order, [10, 20, 30]);
  },

  async 'no stack growth over 100k yield/resume cycles'() {
    const N = 100000;
    const created = Fiber.fibersCreated;
    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    for (let i = 0; i < N; i += 1000) {
      await Promise.all(Array.from({ length: 1000 }, () => new Promise(resolve => {
        Fiber(async () => {
          await null;
          const fiber = Fiber.current;
          setImmediate(() => fiber.run());
          Fiber.yield();
          resolve();
        }).run();
      })));
    }
    global.gc?.();
    const rssMb = (process.memoryUsage().rss - rssBefore) / 1e6;
    console.log(`    coroutines created: ${Fiber.fibersCreated - created}, pool size ${Fiber.poolSize}, rss delta ${rssMb.toFixed(1)}MB`);
    assert(rssMb < 200, `rss grew ${rssMb.toFixed(1)}MB`);
  },

  async 'overhead: 1e6 awaits outside any fiber'() {
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1e6; i++) await null;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`    ${ms.toFixed(0)}ms (run again with FIBERS_DISABLE_MICROTASK_FIBERS=1 to compare)`);
  },
};

(async () => {
  console.log(`microtaskFibers enabled: ${!!Fiber.microtaskFibers}`);
  let failed = 0;
  for (const [name, test] of Object.entries(tests)) {
    try {
      await Promise.race([test(), sleep(10000).then(() => { throw new Error('timed out (deadlock?)'); })]);
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
    }
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
