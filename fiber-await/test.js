// Behaviour checks for running await continuations on fibers. See README.md.
// Run: node fiber-await/test.js                           (dispatch on)
//      FIBERS_AWAIT_REUSE=0 node fiber-await/test.js      (one new fiber per job)
//      FIBERS_AWAIT_DISPATCH=0 node fiber-await/test.js   (baseline: the fiber checks fail, as on stock)
const assert = require('assert');
const { AsyncLocalStorage } = require('async_hooks');
const FIBERS = require('path').join(__dirname, '..');
const Fiber = require(FIBERS);
const Future = require(`${FIBERS}/future`);

const als = new AsyncLocalStorage();

// A fiber-only API, like Orders.find().count(): blocks the current fiber.
function sleepSync(ms) {
  const fut = new Future();
  setTimeout(() => fut.return(ms), ms);
  return fut.wait();
}
const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));
// The fiber code after an await runs on, whether or not Fiber.current shows it.
const anyFiber = () => Fiber.currentIncludingHidden || Fiber.current;

// A dual-mode API, like collection-hooks' cursor.observeChanges: sync in a fiber, Promise otherwise.
function dualMode() {
  const p = tick().then(() => 'handle');
  return Fiber.current ? Future.fromPromise(p).wait() : p;
}

// Run fn in a fiber; resolve with what its returned promise resolves to.
function inFiber(fn) {
  return new Promise((resolve, reject) => {
    Fiber(() => { Promise.resolve(fn()).then(resolve, reject); }).run();
  });
}

const tests = [
  ['JordanTest shape: await, then fiber-only call', () => inFiber(async () => {
    await tick();
    assert.ok(anyFiber(), 'no fiber after await');
    assert.strictEqual(sleepSync(3), 3);
  })],
  ['several awaits, fiber-only call after each', () => inFiber(async () => {
    for (let i = 0; i < 5; i++) {
      await tick(1);
      assert.ok(anyFiber(), `no fiber after await #${i}`);
      sleepSync(1);
    }
  })],
  ['nested async function called from a fiber', () => inFiber(async () => {
    const inner = async () => { await tick(); sleepSync(1); return 'inner'; };
    assert.strictEqual(await inner(), 'inner');
    sleepSync(1);
  })],
  ['.then callback registered in a fiber runs in a fiber', () => inFiber(async () => {
    const seen = await tick().then(() => !!anyFiber());
    assert.ok(seen, '.then callback ran without a fiber');
  })],
  ['AsyncLocalStorage store survives the hop', () => als.run({ user: 'u1' }, () => inFiber(async () => {
    await tick();
    assert.deepStrictEqual(als.getStore(), { user: 'u1' });
    sleepSync(1);
    assert.deepStrictEqual(als.getStore(), { user: 'u1' });
  }))],
  ['concurrent async calls still overlap (Promise.all)', () => inFiber(async () => {
    const start = Date.now();
    const work = async () => { await tick(1); sleepSync(40); };
    await Promise.all([work(), work(), work()]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `expected overlap, took ${elapsed}ms`);
  })],
  ['errors after await reject normally', () => inFiber(async () => {
    const bad = async () => { await tick(); sleepSync(1); throw new Error('boom'); };
    await assert.rejects(bad(), /boom/);
  })],
  ['Fiber.current still reads undefined after await (hidden fiber)', () => inFiber(async () => {
    assert.ok(Fiber.current, 'expected a visible fiber before the first await');
    await tick();
    assert.strictEqual(Fiber.current, undefined);
  })],
  ['dual-mode API still returns a Promise after await', () => inFiber(async () => {
    assert.strictEqual(dualMode(), 'handle', 'expected sync result before the first await');
    await tick();
    const result = dualMode();
    assert.strictEqual(typeof result.catch, 'function', 'got a sync result after await');
    assert.strictEqual(await result, 'handle');
  })],
  ['fiberless code is untouched', async () => {
    assert.ok(!Fiber.current);
    await tick();
    assert.ok(!anyFiber(), 'fiberless continuation got a fiber');
  }],
  ['microtask order unchanged for non-yielding continuations', () => inFiber(async () => {
    const order = [];
    const a = (async () => { await null; order.push('a1'); await null; order.push('a2'); })();
    const b = (async () => { await null; order.push('b1'); await null; order.push('b2'); })();
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ['a1', 'b1', 'a2', 'b2']);
  })],
];

(async () => {
  console.log(`node ${process.version}, dispatch API: ${typeof Fiber.__setMicrotaskDispatcher === 'function'}, FIBERS_AWAIT_DISPATCH=${process.env.FIBERS_AWAIT_DISPATCH ?? '(unset)'}`);
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`microtasksDispatched=${Fiber.microtasksDispatched}, fibersCreated=${Fiber.fibersCreated}`);
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
