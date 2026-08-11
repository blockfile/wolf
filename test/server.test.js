import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { createCache } from '../src/cache.js'
import { TOKEN_ADDRESS } from './fixtures.js'

const silent = { error: () => {}, log: () => {}, warn: () => {} }

/**
 * Boots the app on an ephemeral port and returns a bound fetch helper.
 *
 * Cleanup (`server.close()`) always runs via `finally`, even if `run` throws
 * or an assertion inside it fails — a leaked listener from a failed test is
 * what turns a fast, clear failure into a hung `node --test` process.
 */
async function withServer({ collect, config, cacheTtlMs, staleMaxMs }, run) {
  const app = createServer({
    config,
    statsService: { collect },
    cache: createCache({
      ttlMs: cacheTtlMs ?? config.cacheTtlMs,
      staleMaxMs: staleMaxMs ?? config.staleMaxMs,
    }),
    logger: silent,
  })

  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    return await run((path, init) => fetch(base + path, init))
  } finally {
    await new Promise((r) => server.close(r))
  }
}

const CONFIG = buildConfig({ TOKEN_ADDRESS, CORS_ORIGIN: 'http://localhost:5173' })

/** A realistic collect() payload — the shape stats.js actually emits. */
const PAYLOAD = {
  marketCap: 29863,
  holders: 118,
  burnedPct: 0,
  priceChange24h: 978,
  holdersDelta: 0,
  burnedDelta: 0,
  totalSupply: 1_000_000_000,
  burned: 0,
  placeholder: false,
  source: { marketCap: 'dexscreener-marketCap', holders: 'blockscout' },
  warnings: [],
}

/* ---------------------------------------------------------------------- */
/* GET /coin/stats — the one live endpoint                                 */
/* ---------------------------------------------------------------------- */

test('GET /coin/stats matches the frontend mock shape key-for-key', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats')
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.ok('updatedAt' in body)
    assert.ok('bpm' in body)
    assert.equal(body.items.length, 3)

    const [mcap, holders, burned] = body.items
    assert.deepEqual(Object.keys(mcap).sort(), ['accent', 'delta', 'format', 'id', 'label', 'value'].sort())
    assert.equal(mcap.id, 'mcap')
    assert.equal(mcap.label, 'Marketcap')
    assert.equal(mcap.format, 'usdCompact')
    assert.equal(mcap.accent, 'gold')
    assert.equal(mcap.value, 29863)
    assert.equal(mcap.delta, 978)

    assert.equal(holders.id, 'holders')
    assert.equal(holders.label, 'Total Holders')
    assert.equal(holders.format, 'compact')
    assert.equal(holders.accent, 'bubblegum')
    assert.equal(holders.value, 118)

    assert.equal(burned.id, 'burned')
    assert.equal(burned.label, 'Burned')
    assert.equal(burned.format, 'percent')
    assert.equal(burned.accent, 'flare')
    assert.equal(burned.value, 0)
    assert.ok(!Number.isNaN(burned.value))

    assert.ok(!Number.isNaN(Date.parse(body.updatedAt)))
  })
})

test('a burned value of null (chain read failed) is sent as null, never NaN or 0-that-lies', async () => {
  const failed = { ...PAYLOAD, burnedPct: null }
  await withServer({ config: CONFIG, collect: async () => failed }, async (get) => {
    const body = await (await get('/coin/stats')).json()
    const burned = body.items.find((i) => i.id === 'burned')
    assert.equal(burned.value, null)
  })
})

test('GET /coin/stats sets Cache-Control matching the TTL', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats')
    assert.match(res.headers.get('cache-control'), /max-age=30/)
  })
})

test('a second request within the TTL is served from cache, without calling statsService again', async () => {
  let calls = 0
  const collect = async () => {
    calls++
    return PAYLOAD
  }

  await withServer({ config: CONFIG, collect }, async (get) => {
    assert.equal((await get('/coin/stats')).status, 200)
    assert.equal((await get('/coin/stats')).status, 200)
    assert.equal(calls, 1, 'the second request must not re-invoke the stats service')
  })
})

test('allows a configured origin and sets Vary', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats', { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.match(res.headers.get('vary') ?? '', /Origin/)
  })
})

test('does not allow an unlisted origin', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats', { headers: { Origin: 'https://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })
})

test('answers a CORS preflight with 204', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.status, 204)
  })
})

test('a wildcard allowlist admits any origin', async () => {
  const config = buildConfig({ TOKEN_ADDRESS, CORS_ORIGIN: '*' })
  await withServer({ config, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/coin/stats', { headers: { Origin: 'https://anywhere.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})

test('returns 503 when collection fails with nothing cached', async () => {
  await withServer(
    { config: CONFIG, collect: async () => { throw new Error('everything is down') } },
    async (get) => {
      const res = await get('/coin/stats')
      const body = await res.json()
      assert.equal(res.status, 503)
      assert.equal(body.error, 'stats unavailable')
    },
  )
})

test('GET /coin/stats degrades within the wait budget instead of hanging on a cold cache', async () => {
  const config = buildConfig({ TOKEN_ADDRESS, STATS_WAIT_MS: 50 })
  const collect = () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(PAYLOAD), 2000)
      t.unref?.()
    })

  await withServer({ config, collect }, async (get) => {
    const startedAt = Date.now()
    const res = await get('/coin/stats')
    const elapsedMs = Date.now() - startedAt

    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.error, /warming/)
    assert.ok(
      elapsedMs < 1000,
      `expected a prompt response well inside the 2000ms collection delay, took ${elapsedMs}ms`,
    )
  })
})

test('serves the last good payload with stale:true (still 200) after a failure', async () => {
  const config = buildConfig({ TOKEN_ADDRESS, CACHE_TTL_MS: 0, STALE_MAX_MS: 600000 })
  let healthy = true
  const collect = async () => {
    if (!healthy) throw new Error('upstreams down')
    return PAYLOAD
  }

  await withServer({ config, collect }, async (get) => {
    assert.equal((await get('/coin/stats')).status, 200)

    healthy = false
    const res = await get('/coin/stats')
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.items.find((i) => i.id === 'mcap').value, 29863)
  })
})

/* ---------------------------------------------------------------------- */
/* GET /health                                                             */
/* ---------------------------------------------------------------------- */

test('GET /health reports config without touching upstreams', async () => {
  await withServer(
    { config: CONFIG, collect: async () => { throw new Error('should not be called') } },
    async (get) => {
      const res = await get('/health')
      const body = await res.json()
      assert.equal(res.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.tokenConfigured, true)
    },
  )
})

test('unknown routes 404 as JSON', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/nope')
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error, 'not found')
  })
})

/* ---------------------------------------------------------------------- */
/* Static content routes — required so flipping VITE_USE_MOCK_API off does */
/* not 404 the identity panel, marquee or gallery.                         */
/* ---------------------------------------------------------------------- */

test('GET /coin/meta serves Land of Wolf identity with the verified LANDWOLF contract', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const body = await (await get('/coin/meta')).json()
    assert.equal(body.contract, '0x8907ece9cbba1e2766263b3b5126ec65ab3ff77c')
    assert.notEqual(body.contract, '0x105cca066775368454bf243d3dd4c623c7e6150c', 'must not be the donor $BRETT contract')
    assert.notEqual(body.contract, 'SET_CONTRACT_ADDRESS_BEFORE_LAUNCH', 'the pre-launch sentinel must not survive into production')
    assert.equal(body.ticker, 'WOLF')
    assert.ok(Array.isArray(body.socials))
  })
})

/* ---------------------------------------------------------------------- */
/* GET /stats — the shape the Landwolf site actually calls.               */
/* Different frontend, different contract: a flat {marketCapUsd, holders}, */
/* no items array, no burned tile, no deltas. See src/api/stats.js in      */
/* D:\projects\tokenmeme1.                                                 */
/* ---------------------------------------------------------------------- */

test('GET /stats serves the flat {marketCapUsd, holders} the site reads', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats')
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.marketCapUsd, PAYLOAD.marketCap)
    assert.equal(body.holders, PAYLOAD.holders)
  })
})

/* The field name IS the integration. The site reads `marketCapUsd`; a
   rename here renders a permanently blank tile with no error anywhere,
   because it reads a key that simply is not present. */
test('GET /stats names the field marketCapUsd, not marketCap', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const body = await (await get('/stats')).json()
    assert.ok('marketCapUsd' in body, 'the site keys on marketCapUsd')
    assert.equal(typeof body.marketCapUsd, 'number')
  })
})

/* Same cached collection as /coin/stats — no second upstream fetch. This
   project's lineage has taken two production outages from one extra
   sequential upstream call, so a second collect() here would be that same
   mistake in a new place. */
test('GET /stats and GET /coin/stats share one cached collect(), not two', async () => {
  let collects = 0
  const collect = async () => {
    collects += 1
    return PAYLOAD
  }
  await withServer({ config: CONFIG, collect }, async (get) => {
    await get('/coin/stats')
    await get('/stats')
    await get('/stats')
    assert.equal(collects, 1, '/stats must reuse the cache, never collect again')
  })
})

test('GET /coin/ticker serves the marquee lines', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const body = await (await get('/coin/ticker')).json()
    assert.ok(Array.isArray(body.lines))
    assert.ok(body.lines.length > 0)
    assert.equal(typeof body.bpm, 'number')
  })
})

test('GET /gallery/categories serves the category list', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const body = await (await get('/gallery/categories')).json()
    assert.ok(Array.isArray(body))
    assert.ok(body.some((c) => c.id === 'all'))
  })
})

test('GET /gallery returns the {items, meta} envelope the frontend expects', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const body = await (await get('/gallery')).json()
    assert.ok(Array.isArray(body.items))
    assert.deepEqual(Object.keys(body.meta).sort(), ['hasMore', 'page', 'perPage', 'total'].sort())
    assert.equal(body.meta.page, 1)
    assert.equal(body.meta.perPage, 24)
  })
})

test('GET /gallery honours category, page and perPage', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const all = await (await get('/gallery')).json()
    assert.ok(all.meta.total >= 1)

    const paged = await (await get('/gallery?page=1&perPage=1')).json()
    assert.equal(paged.items.length, 1)
    assert.equal(paged.meta.hasMore, all.meta.total > 1)

    const wrongCategory = await (await get('/gallery?category=crew')).json()
    assert.equal(wrongCategory.items.length, 0, 'no seeded items are in the crew category')

    const rightCategory = await (await get('/gallery?category=rig')).json()
    assert.equal(rightCategory.meta.total, all.meta.total)
  })
})

test('GET /gallery/:id returns the matching item', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const list = await (await get('/gallery')).json()
    const id = list.items[0].id

    const res = await get(`/gallery/${id}`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).id, id)
  })
})

test('GET /gallery/:id 404s for an unknown id', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/gallery/does-not-exist')
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error, 'not found')
  })
})
