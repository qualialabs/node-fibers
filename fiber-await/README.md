# Measuring the fiber-await prototype

Measurement tooling for running `await` continuations on fibers ([node#7](https://github.com/qualialabs/node/pull/7) + [node#9](https://github.com/qualialabs/node/pull/9), [node-fibers#6](https://github.com/qualialabs/node-fibers/pull/6) + [#8](https://github.com/qualialabs/node-fibers/pull/8)). It lives on its own branch so it never ships: build fibers from this branch only in environments you want to measure.

This branch adds, on top of #8:
- `Fiber.microtaskDrains`, `Fiber.drainsWithDispatch`, `Fiber.redispatches` (C++ counters; `Fiber.microtasksDispatched` and `Fiber.microtasksBatched` already exist)
- `fiber-await/test.js`, `fiber-await/bench.js`, `fiber-await/app_stats.mjs`

## Node 24

On node 24 run everything with `--no-async-context-frame`, e.g. `node --no-deprecation --no-async-context-frame fiber-await/test.js`. With AsyncContextFrame on (node 24's default), AsyncLocalStorage keeps its state in the same V8 slot the dispatcher tags with, so fibers doesn't install the dispatcher (`Fiber.awaitDispatchEnabled` is `false`; set `FIBERS_AWAIT_DISPATCH=1` to get a warning instead). Fibers on node 24 needs the flag anyway.

## What gets measured

A promise callback (the code after an `await`, a `.then` callback) is **tagged** if it was registered while a fiber was running. Tagged callbacks are run on a hidden *dispatch fiber*; untagged ones run on the main stack as on stock node.

| Counter | Meaning |
|---|---|
| `microtasksDispatched` | Switches onto a dispatch fiber |
| `microtasksBatched` | Tagged callbacks run on the dispatch fiber without a switch (they were queued right behind another tagged one) |
| `microtaskDrains` | Microtask checkpoints on the default queue, including empty ones (node checkpoints about twice per event-loop turn) |
| `drainsWithDispatch` | Drains that switched onto a dispatch fiber at least once |
| `redispatches` | Further switches within the same drain: an untagged callback between two tagged ones sent us back to the main stack |

Each switch costs about one fiber `run()` + `yield()` round trip. On the `CORO_PTHREAD` backend (Linux, arm64) every fiber is an OS thread, so that's a thread handoff.

## Behaviour checks

```sh
node --no-deprecation fiber-await/test.js                          # expect: all passed
FIBERS_AWAIT_REUSE=0 node --no-deprecation fiber-await/test.js     # one new fiber per job; all passed
FIBERS_AWAIT_DISPATCH=0 node --no-deprecation fiber-await/test.js  # baseline: 7 fail, as on stock node
```

znewsham's scenarios from [node-fibers#7](https://github.com/qualialabs/node-fibers/pull/7) (`test-microtask-fibers.js`) also run here once `Fiber.current` is replaced with `(Fiber.currentIncludingHidden || Fiber.current)`, since this design hides the fiber from `Fiber.current`. With `Fiber.poolSize = 1e9`, 7/7 behaviour tests pass. Its 100k park/resume test takes about 10 s here, just over its 10 s timeout.

## Microbenchmarks

```sh
node --no-deprecation fiber-await/bench.js
BENCH=switch node --no-deprecation fiber-await/bench.js   # one benchmark; also works on stock node + fibers
```

Run it with the same binary and `FIBERS_AWAIT_REUSE=0` / `FIBERS_AWAIT_DISPATCH=0`, and with stock node, to compare. `switch` needs no patch, so it can measure the thread-handoff floor on any environment before deploying anything.

Reference numbers from one `bench.js` run per column (arm64 Docker Desktop VM on an M-series Mac, node 18.16.1, 2026-10-02; expect run-to-run variance of 10-30%):

| Benchmark | stock node + fibers | patched, `FIBERS_AWAIT_REUSE=0` | patched (reuse on) |
|---|---|---|---|
| `switch` (run+yield round trip) | 20.4 us | 24.7 us | 20.6 us |
| `chain` | 0.04 us | 24.8 us | 0.13 us |
| `io` | 0.61 us | 31.8 us | 20.8 us |
| `interleaved` | 0.09 us | 28.3 us | 21.8 us |
| `fiberless` | 0.04 us | 0.04 us | 0.05 us |
| `drains` | 0.57 us | 0.70 us | 0.74 us |
| `park` | skipped | 158.9 us | 145.9 us |

The harness runs inside one long-lived async loop, so its counter deltas can show a `redispatches` count where a real app would see a new drain. Use the per-op times from `bench.js` and the counters from `app_stats.mjs`.

## Sampling a running app

From a Meteor shell (or another REPL in the app process). If `fibers/...` doesn't resolve from the shell, import the file by absolute path instead:

```js
const s = await import('fibers/fiber-await/app_stats.mjs');
s.start();                 // then use the app
s.stop();                  // counts and percentages for the window
s.measureSwitch();         // { roundTripUs } in this process; blocks the event loop briefly
s.stop({ roundTripUs })    // after another start(): also estimates the time spent switching
```

`start()` counts every promise callback with a `v8.promiseHooks` `before` hook (one JS call per promise job), so stop it when you're done. Non-promise `queueMicrotask` callbacks are not counted; they're never tagged.

Reference (local qualia, one user clicking for 88 s, 2026-10-02): 13.7% of promise callbacks tagged, 3.2% of untagged callbacks caused a switch, 1.9% of drains used the dispatch fiber, 71% of tagged callbacks batched; 4,738 switches ≈ 0.1–0.25% of a core at 20–45 us each. Idle: 6.9% tagged, 0.29% of untagged caused a switch.
