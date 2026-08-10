import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createStatsService } from '../src/stats.js'
import { SELECTORS, encodeBalanceOf } from '../src/chain/abi.js'
import {
  TOKEN_ADDRESS,
  TOTAL_SUPPLY_RETURNDATA,
  DECIMALS_18_RETURNDATA,
  DEAD_ADDRESS,
  ZERO_ADDRESS,
  ZERO_BALANCE_RETURNDATA,
  DEAD_BALANCE_NONZERO_RETURNDATA,
  ZERO_BALANCE_NONZERO_RETURNDATA,
  BLOCKSCOUT_COUNTERS,
  DEXSCREENER_TOKENS,
  stubFetch,
} from './fixtures.js'

/** The exact calldata readChain sends for the two burn reads. */
const DEAD_CALL_DATA = encodeBalanceOf(DEAD_ADDRESS)
const ZERO_CALL_DATA = encodeBalanceOf(ZERO_ADDRESS)

function config(overrides = {}) {
  return buildConfig({ TOKEN_ADDRESS, ...overrides })
}

/**
 * RPC stub that answers by (to, selector) rather than by position, so a
 * change in batching order does not quietly invalidate the test. Defaults to
 * the verified live state: 0 burned.
 */
function stubRpc({ fail = null, overrides = {} } = {}) {
  return {
    async ethCallBatch(calls) {
      if (fail) throw new Error(fail)
      return calls.map(({ to, data }) => {
        const key = `${to.toLowerCase()}:${data}`
        if (key in overrides) {
          const v = overrides[key]
          if (v instanceof Error) throw v
          return v
        }
        if (data === SELECTORS.totalSupply) return TOTAL_SUPPLY_RETURNDATA
        if (data === SELECTORS.decimals) return DECIMALS_18_RETURNDATA
        if (data === DEAD_CALL_DATA) return ZERO_BALANCE_RETURNDATA
        if (data === ZERO_CALL_DATA) return ZERO_BALANCE_RETURNDATA
        throw new Error(`unexpected call ${key}`)
      })
    },
  }
}

const HAPPY_ROUTES = [
  ['/api/v2/tokens/', async () => BLOCKSCOUT_COUNTERS],
  ['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS],
]

/** A snapshot store stub with no history — every delta must read 0. */
function noHistorySnapshotStore() {
  return {
    async read() { return null },
    async write() {},
    todayKey: () => '2026-08-10',
  }
}

test('prices from Dexscreener\'s own marketCap field when it is present', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.marketCap, 'dexscreener-marketCap')
  assert.equal(stats.marketCap, 29863)
  assert.equal(stats.source.holders, 'blockscout')
  assert.equal(stats.holders, 118)
  assert.equal(stats.totalSupply, 1_000_000_000)
  assert.equal(stats.placeholder, false)
  assert.deepEqual(stats.warnings, [])

  /* Verified on-chain 2026-08-10: nothing burned yet. Must render as a clean
     0, never NaN or a raw 18-decimal integer. */
  assert.equal(stats.burned, 0)
  assert.equal(stats.burnedPct, 0)
  assert.ok(!Number.isNaN(stats.burnedPct))
})

test('falls back to priceUsd x totalSupply when Dexscreener has no marketCap field', async () => {
  const noMcap = {
    ...DEXSCREENER_TOKENS,
    pairs: [{ ...DEXSCREENER_TOKENS.pairs[0], marketCap: undefined, fdv: undefined }],
  }
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => BLOCKSCOUT_COUNTERS],
      ['/latest/dex/tokens/', async () => noMcap],
    ]),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.marketCap, 'priceUsd-times-totalSupply')
  assert.ok(Math.abs(stats.marketCap - 0.00002986 * 1_000_000_000) < 0.01)
})

test('sends the burn reads in the SAME ethCallBatch call as totalSupply, not a second one', async () => {
  /* This is the constraint the whole feature exists for. The donor project's
     504 outage — twice — came from a sequential upstream call composing past
     nginx's proxy_read_timeout (see config.js's waitBudgetWarning). A burn
     implementation that gets the right number via a second ethCallBatch, or
     an extra sequential await, is wrong even though the figure would be
     correct. Asserted on the calls ARRAY handed to ethCallBatch, not on
     timing, so a future refactor into a second call fails this test
     immediately rather than only under load. */
  const batchCalls = []
  const baseRpc = stubRpc()
  const rpc = {
    async ethCallBatch(calls, opts) {
      batchCalls.push(calls)
      return baseRpc.ethCallBatch(calls, opts)
    },
  }

  const svc = createStatsService({
    config: config(),
    rpc,
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  await svc.collect()

  assert.equal(batchCalls.length, 1, 'exactly one ethCallBatch call for the whole chain read')
  assert.deepEqual(
    batchCalls[0].map((c) => c.data),
    [SELECTORS.totalSupply, SELECTORS.decimals, DEAD_CALL_DATA, ZERO_CALL_DATA],
  )
})

test('holders, chain and dexscreener are fetched in ONE concurrent group, not sequentially', async () => {
  /* Regression test for the class of production 504 the donor project hit
     twice: if a future change made any of these three await one another
     instead of running inside the same Promise.allSettled, this test's
     elapsed time would roughly double (or triple). Each upstream here
     carries the same artificial delay; concurrent execution keeps the total
     close to one delay, not the sum of three. */
  const DELAY_MS = 150
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  const baseRpc = stubRpc()
  const rpc = {
    async ethCallBatch(calls, opts) {
      await delay(DELAY_MS)
      return baseRpc.ethCallBatch(calls, opts)
    },
  }

  const baseFetch = stubFetch(HAPPY_ROUTES)
  const fetchImpl = async (url, init) => {
    await delay(DELAY_MS)
    return baseFetch(url, init)
  }

  const svc = createStatsService({
    config: config(),
    rpc,
    fetchImpl,
    snapshotStore: noHistorySnapshotStore(),
  })

  const startedAt = Date.now()
  await svc.collect()
  const elapsedMs = Date.now() - startedAt

  assert.ok(
    elapsedMs < DELAY_MS * 2,
    `expected concurrent upstream calls (~${DELAY_MS}ms), took ${elapsedMs}ms — looks sequential`,
  )
})

test('a failed burn read degrades burned/burnedPct to null without touching marketCap or holders', async () => {
  /* Truncated returndata (not an Error thrown from ethCallBatch itself) so
     only the burn-word DECODE fails — totalSupply and decimals, decoded
     earlier in readChain, already succeeded by the time this is reached. */
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: { [`${TOKEN_ADDRESS}:${DEAD_CALL_DATA}`]: '0x1234' },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.burned, null)
  assert.equal(stats.burnedPct, null)
  assert.ok(
    stats.warnings.some((w) => w.includes('burn read failed')),
    `expected a burn warning, got ${JSON.stringify(stats.warnings)}`,
  )
  assert.equal(stats.marketCap, 29863, 'market cap must survive')
  assert.equal(stats.holders, 118, 'holders must survive')
})

test('guards the burnedPct division: zero supply yields null, not Infinity or NaN', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: { [`${TOKEN_ADDRESS}:${SELECTORS.totalSupply}`]: '0x' + '0'.repeat(64) },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.totalSupply, 0)
  assert.equal(stats.burnedPct, null)
  assert.equal(stats.burned, 0, 'burned itself is still a real figure')
})

test('computes a real, nonzero burnedPct correctly when there IS a burn balance', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: { [`${TOKEN_ADDRESS}:${DEAD_CALL_DATA}`]: DEAD_BALANCE_NONZERO_RETURNDATA },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.burned, 12_345)
  assert.ok(Math.abs(stats.burnedPct - 0.0012345) < 1e-9)
})

test('burned sums balanceOf(dead) AND balanceOf(zero), not just one sink', async () => {
  // dead=0 (default), zero=500 tokens — if the zero-address read were ever
  // dropped, this would silently read 0 instead of 500.
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: { [`${TOKEN_ADDRESS}:${ZERO_CALL_DATA}`]: ZERO_BALANCE_NONZERO_RETURNDATA },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()
  assert.equal(stats.burned, 500)
})

test('emits the exact field names the frontend tile shape reads', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  for (const key of ['marketCap', 'holders', 'burnedPct', 'priceChange24h', 'holdersDelta', 'burnedDelta']) {
    assert.ok(key in stats, `payload must carry ${key}`)
  }
  assert.equal(typeof stats.marketCap, 'number')
  assert.equal(typeof stats.holders, 'number')
})

test('mcap 24h delta is Dexscreener\'s priceChange.h24, passed through as-is', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()
  assert.equal(stats.priceChange24h, 978)
})

test('holders unavailable: marketCap survives, holders becomes null with a warning', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => new Error('explorer down')],
      ['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS],
    ]),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.holders, null)
  assert.equal(stats.source.holders, 'none')
  assert.equal(stats.marketCap, 29863, 'mcap should survive losing holders')
  assert.ok(stats.warnings.some((w) => w.includes('holders unavailable')))
})

test('dexscreener down: marketCap is null (no chain-derived fallback possible without a price), holders survives', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => BLOCKSCOUT_COUNTERS],
      ['/latest/dex/tokens/', async () => new Error('dexscreener down')],
    ]),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.marketCap, null)
  assert.equal(stats.holders, 118, 'holders should survive a Dexscreener outage')
  assert.ok(stats.warnings.some((w) => w.includes('dexscreener unavailable')))
  assert.ok(stats.warnings.some((w) => w.includes('market cap could not be derived')))
})

test('reports nulls, not a throw, when every source is down', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({ fail: 'rpc unreachable' }),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => new Error('down')],
      ['/latest/dex/tokens/', async () => new Error('down')],
    ]),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.marketCap, null)
  assert.equal(stats.holders, null)
  assert.equal(stats.burnedPct, null)
  assert.ok(stats.warnings.length >= 3)
})

test('returns the pre-launch placeholder when TOKEN_ADDRESS is unset, and touches no upstream', async () => {
  const fetchImpl = stubFetch(HAPPY_ROUTES)
  const svc = createStatsService({
    config: buildConfig({}),
    rpc: stubRpc(),
    fetchImpl,
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()

  assert.equal(stats.placeholder, true)
  assert.equal(stats.marketCap, null)
  assert.equal(stats.holders, null)
  assert.equal(stats.holdersDelta, 0)
  assert.equal(stats.burnedDelta, 0)
  assert.deepEqual(stats.warnings, ['TOKEN_ADDRESS is not set'])
  assert.equal(fetchImpl.calls.length, 0)
})

/* ---- Delta wiring: real snapshot.js integration, not just the pure functions
   tested directly in snapshot.test.js. ---- */

test('holders/burned deltas are 0 when the snapshot store has no history', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore: noHistorySnapshotStore(),
  })

  const stats = await svc.collect()
  assert.equal(stats.holdersDelta, 0)
  assert.equal(stats.burnedDelta, 0)
})

test('holders/burned deltas are real numbers, diffed against the previous snapshot, when one exists', async () => {
  const snapshotStore = {
    async read() { return { date: '2026-08-09', holders: 100, burnedPct: 0 } },
    async write() {},
    todayKey: () => '2026-08-10',
  }

  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore,
  })

  const stats = await svc.collect()

  // 118 holders today vs 100 yesterday -> +18%.
  assert.ok(Math.abs(stats.holdersDelta - 18) < 1e-9)
  // 0% burned today vs 0% yesterday -> 0 points of change.
  assert.equal(stats.burnedDelta, 0)
})

test('a snapshot read failure degrades deltas to 0 rather than failing collect()', async () => {
  const snapshotStore = {
    async read() { throw new Error('disk error') },
    async write() {},
    todayKey: () => '2026-08-10',
  }

  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore,
  })

  const stats = await svc.collect()
  assert.equal(stats.holdersDelta, 0)
  assert.equal(stats.burnedDelta, 0)
  assert.equal(stats.holders, 118, 'the rest of the payload must be unaffected')
})

test('collect() writes a new snapshot once the stored date is not today, and does not await the write', async () => {
  let writeCalls = 0
  let resolveWrite
  const writeStarted = new Promise((r) => { resolveWrite = r })

  const snapshotStore = {
    async read() { return { date: '2026-08-09', holders: 100, burnedPct: 0 } },
    async write(data) {
      writeCalls++
      resolveWrite(data)
      // Deliberately slow — proves collect() does not wait on this.
      await new Promise((r) => setTimeout(r, 200))
    },
    todayKey: () => '2026-08-10',
  }

  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore,
  })

  const startedAt = Date.now()
  await svc.collect()
  const elapsedMs = Date.now() - startedAt

  assert.ok(elapsedMs < 150, `collect() must not wait on the slow write, took ${elapsedMs}ms`)
  const written = await writeStarted
  assert.deepEqual(written, { holders: 118, burnedPct: 0 })
  assert.equal(writeCalls, 1)
})

test('collect() does not write a new snapshot when today already has one', async () => {
  let writeCalls = 0
  const snapshotStore = {
    async read() { return { date: '2026-08-10', holders: 118, burnedPct: 0 } },
    async write() { writeCalls++ },
    todayKey: () => '2026-08-10',
  }

  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
    snapshotStore,
  })

  await svc.collect()
  await new Promise((r) => setTimeout(r, 0)) // flush any fire-and-forget write

  assert.equal(writeCalls, 0, 'a snapshot already dated today must not be rewritten')
})
