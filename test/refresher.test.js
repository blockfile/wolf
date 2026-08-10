import test from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../src/cache.js'
import { createRefresher } from '../src/refresher.js'

const silent = { error: () => {}, warn: () => {} }

/** Fake statsService — the refresher only ever calls .collect(). */
function statsStub(collect) {
  return { collect }
}

/**
 * Fake setInterval/clearInterval: records what was scheduled instead of
 * touching the real clock, and lets a test fire a tick by hand and await it —
 * so refresh timing is deterministic rather than racing a real timer.
 */
function fakeTimer() {
  const scheduled = []
  const cleared = []
  return {
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms }
      scheduled.push(handle)
      return handle
    },
    clearIntervalFn: (handle) => cleared.push(handle),
    scheduled,
    cleared,
    fire: (handle) => handle.fn(),
  }
}

/** Flushes the microtask/macrotask queue so a fire-and-forget refresh settles. */
const flush = () => new Promise((r) => setTimeout(r, 0))

test('start() refreshes immediately, without waiting for the interval', async () => {
  const cache = createCache({ ttlMs: 60_000, staleMaxMs: 60_000 })
  let calls = 0
  const statsService = statsStub(async () => ({ n: ++calls }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    intervalMs: 20_000,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush()

  assert.equal(calls, 1, 'collect should have run once immediately, not on the first tick')

  refresher.stop()
})

test('a request-shaped cache.get() is served from the warm cache without touching statsService again', async () => {
  /* This is the point of the whole module: once start() has run, an incoming
     GET /coin/stats (modelled here as a bare cache.get() call, exactly what
     server.js does) must be answered from the cache alone. */
  const cache = createCache({ ttlMs: 60_000, staleMaxMs: 60_000 })
  let calls = 0
  const statsService = statsStub(async () => ({ n: ++calls }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush()

  const { value } = await cache.get(async () => {
    throw new Error('should not be called — the cache should already be warm')
  })

  assert.deepEqual(value, { n: 1 })
  assert.equal(calls, 1, 'the simulated request must not trigger a second collection')

  refresher.stop()
})

test('schedules subsequent refreshes on the configured interval', async () => {
  const cache = createCache({ ttlMs: 0, staleMaxMs: 60_000 })
  let calls = 0
  const statsService = statsStub(async () => ({ n: ++calls }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    intervalMs: 12_345,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush()
  assert.equal(timer.scheduled.length, 1, 'exactly one interval should be scheduled')
  assert.equal(timer.scheduled[0].ms, 12_345, 'the configured interval must be passed through')

  await timer.fire(timer.scheduled[0])
  await timer.fire(timer.scheduled[0])

  assert.equal(calls, 3, 'one immediate refresh plus two manual ticks')

  refresher.stop()
})

test('does not schedule a second interval if start() is called twice', async () => {
  const cache = createCache({ ttlMs: 60_000, staleMaxMs: 60_000 })
  const statsService = statsStub(async () => ({ ok: true }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  refresher.start()
  await flush()

  assert.equal(timer.scheduled.length, 1, 'a second start() must not schedule a second interval')

  refresher.stop()
})

test('stop() clears the interval and is safe to call twice', async () => {
  const cache = createCache({ ttlMs: 60_000, staleMaxMs: 60_000 })
  const statsService = statsStub(async () => ({ ok: true }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush()

  refresher.stop()
  assert.equal(timer.cleared.length, 1)
  assert.equal(timer.cleared[0], timer.scheduled[0], 'must clear the exact handle it scheduled')

  assert.doesNotThrow(() => refresher.stop())
  assert.equal(timer.cleared.length, 1, 'a second stop() must not clear again')
})

test('stop() then start() again works — the timer can be restarted cleanly', async () => {
  const cache = createCache({ ttlMs: 0, staleMaxMs: 60_000 })
  let calls = 0
  const statsService = statsStub(async () => ({ n: ++calls }))
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush()
  refresher.stop()

  refresher.start()
  await flush()

  assert.equal(timer.scheduled.length, 2, 'restarting should schedule a fresh interval')
  assert.equal(calls, 2, 'restarting should trigger a fresh immediate refresh')

  refresher.stop()
})

test('a transient refresh failure is absorbed by the stale window: last good value survives, refresher does not throw', async () => {
  const cache = createCache({ ttlMs: 0, staleMaxMs: 600_000 })
  let healthy = true
  const statsService = statsStub(async () => {
    if (!healthy) throw new Error('upstreams down')
    return { marketCap: 111 }
  })
  const timer = fakeTimer()

  const refresher = createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush() // first tick succeeds, warms the cache with { marketCap: 111 }

  healthy = false
  await assert.doesNotReject(
    () => timer.fire(timer.scheduled[0]),
    'a failed refresh must not reject / throw out of the timer callback',
  )

  const { value, stale } = await cache.get(async () => {
    throw new Error('should not be called; proving the stale value survives needs no new fetch')
  })
  assert.deepEqual(value, { marketCap: 111 })
  assert.equal(stale, true)

  refresher.stop()
})

test('a refresh failure past the stale window is logged and does not crash the refresher', async () => {
  let t = 1_000_000
  const now = () => t
  const cache = createCache({ ttlMs: 0, staleMaxMs: 1_000, now })
  let healthy = true
  const statsService = statsStub(async () => {
    if (!healthy) throw new Error('upstreams down')
    return { marketCap: 111 }
  })
  const timer = fakeTimer()
  const errors = []
  const logger = { error: (...args) => errors.push(args), warn: () => {} }

  const refresher = createRefresher({
    cache,
    statsService,
    logger,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  refresher.start()
  await flush() // succeeds at t=1_000_000, warms the cache

  healthy = false
  t += 5_000 // past staleMaxMs (1_000) — cache.get() will now actually reject

  await assert.doesNotReject(
    () => timer.fire(timer.scheduled[0]),
    'a rejection past the stale window must still be caught inside the refresher',
  )

  assert.equal(errors.length, 1, 'the failure should be logged exactly once')
  assert.match(errors[0].join(' '), /upstreams down/)

  refresher.stop()
})

test('constructing a refresher does not start it — nothing runs until start() is called', async () => {
  const cache = createCache({ ttlMs: 60_000, staleMaxMs: 60_000 })
  let calls = 0
  const statsService = statsStub(async () => ({ n: ++calls }))
  const timer = fakeTimer()

  createRefresher({
    cache,
    statsService,
    logger: silent,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  })

  await flush()

  assert.equal(calls, 0, 'constructing a refresher must not run a collection')
  assert.equal(timer.scheduled.length, 0, 'constructing a refresher must not schedule a timer')
})
