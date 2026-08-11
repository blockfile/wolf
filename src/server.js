/**
 * HTTP SERVER
 * -----------------------------------------------------------------------------
 * Express wiring only. Live-data concerns live in stats.js, caching in
 * cache.js, static content in content.js — this file decides routes, status
 * codes and headers, nothing more.
 *
 * Serves all six paths the frontend's mock layer answers (see
 * D:\projects\tokenmeme2\src\api\endpoints.js and client.js): only
 * /coin/stats is live, the other five are static config (content.js) — see
 * that file's header for why serving all six, not just stats, is required.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy): the CORS
 * middleware and withDeadline() are carried over unchanged, /quote and
 * /quote/status are dropped entirely (swap is out of scope — see the design
 * doc), and /stats becomes /coin/stats, reshaped to the frontend's tile
 * contract.
 */

import express from 'express'
import { coinMeta, tickerFeed, galleryCategories, galleryItems, CONTENT_BPM } from './content.js'

/**
 * CORS for public, read-only, credential-free endpoints.
 *
 * Written out rather than pulling in the `cors` package: the policy is a GET
 * allowlist and a preflight reply, and a dependency for that is not worth the
 * supply-chain surface.
 */
function cors(origins) {
  return (req, res, next) => {
    const origin = req.headers.origin

    if (origins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*')
    } else if (origin && origins.includes(origin.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      /* Responses differ by Origin, so any shared cache in front of this must
         key on it — without Vary, one visitor's allowed origin header can be
         replayed to a visitor from a different one. */
      res.setHeader('Vary', 'Origin')
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')

    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  }
}

/** Distinguishes "the wait budget ran out" from a genuine collection failure. */
class StatsTimeoutError extends Error {}

/**
 * Bounds how long a caller waits on `promise`.
 *
 * If `promise` settles first, that settlement passes through untouched. If
 * `ms` elapses first, this rejects with `onTimeout()`'s error instead — but
 * `promise` itself is left running, uncancelled: the fetch it represents is
 * populating the *shared* cache (see cache.js's single-flight coalescing and
 * refresher.js), not answering this one caller, so whichever request happens
 * to be the one that started it should not be able to cut it short just
 * because that request gave up waiting. `promise`'s eventual result (or
 * failure) is still handled right here via the `.then` below, so it can
 * never surface as an unhandled promise rejection even though nothing else
 * is still waiting on it.
 */
function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Reshapes stats.js's collect() output into the frontend's tile contract.
 * `id`, `label`, `format` and `accent` must match
 * D:\projects\tokenmeme2\src\api\mock\stats.js key-for-key — they are the
 * frontend's own vocabulary, selecting the formatter (src/lib/format.js) and
 * the tile's colour. `value` stays a raw number (or null); the frontend does
 * all formatting.
 */
function toStatsPayload(value, updatedAt) {
  return {
    updatedAt: new Date(updatedAt).toISOString(),
    bpm: CONTENT_BPM,
    items: [
      {
        id: 'mcap',
        label: 'Marketcap',
        value: value.marketCap,
        format: 'usdCompact',
        delta: value.priceChange24h ?? 0,
        accent: 'gold',
      },
      {
        id: 'holders',
        label: 'Total Holders',
        value: value.holders,
        format: 'compact',
        delta: value.holdersDelta,
        accent: 'bubblegum',
      },
      {
        id: 'burned',
        label: 'Burned',
        value: value.burnedPct,
        format: 'percent',
        delta: value.burnedDelta,
        accent: 'flare',
      },
    ],
  }
}

/** Clamps a query-string number to a finite positive value, or the default. */
function positiveIntParam(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.statsService  createStatsService instance
 * @param {object} deps.cache         createCache instance
 * @param {object} [deps.logger]
 */
export function createServer({ config, statsService, cache, logger = console }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors(config.corsOrigins))

  /** Liveness. Deliberately touches no upstream, so it stays up when they don't. */
  app.get('/health', (_req, res) => {
    res.json({ ok: true, tokenConfigured: Boolean(config.tokenAddress) })
  })

  /* The `updatedAt` of the last collection whose warnings were logged, so a
     cached degraded payload is reported once rather than on every request
     that reads it. */
  let lastWarnedAt = null

  /* GET /stats — what the Landwolf site actually calls.
   *
   * The site (D:\projects\tokenmeme1, src/api/stats.js) asks for `/stats` and
   * reads a flat `{ marketCapUsd, holders }`. It is a different frontend from
   * the one /coin/stats was shaped for: it has no burned tile, no 24h deltas,
   * no marquee, and its identity — contract, socials, buy link — is
   * hard-coded in src/config/token.js and never touches the network. So the
   * five static /coin/* and /gallery routes below serve nothing it asks for.
   *
   * Both shapes are served rather than one replaced, because they cost the
   * same: this route reads the SAME cached collect() the others do, so it
   * adds no RPC call, no round trip and no wait budget of its own.
   *
   * Field names are the site's, not this backend's — `marketCapUsd`, not
   * `marketCap`. A rename here shows up as a permanently blank tile with no
   * error anywhere, because the site reads a key that isn't there. */
  app.get('/stats', async (req, res) => {
    try {
      const { value, updatedAt } = await withDeadline(
        cache.get(() => statsService.collect()),
        config.statsWaitMs,
        () =>
          new StatsTimeoutError(
            `stats collection exceeded the ${config.statsWaitMs}ms wait budget`,
          ),
      )

      if (value?.warnings?.length && updatedAt !== lastWarnedAt) {
        lastWarnedAt = updatedAt
        logger.warn?.('[stats] degraded:', value.warnings.join('; '))
      }

      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
      )
      res.json({
        marketCapUsd: value.marketCap,
        holders: value.holders,
      })
    } catch (err) {
      if (err instanceof StatsTimeoutError) {
        logger.warn?.(`[stats] cold start: no cached value within ${config.statsWaitMs}ms`)
        return res.status(503).json({
          error: 'stats warming up',
          detail: 'no cached figures yet; try again shortly',
        })
      }
      logger.error?.('[stats] failed:', err.message)
      res.status(503).json({ error: 'stats unavailable', detail: err.message })
    }
  })

  app.get('/coin/stats', async (req, res) => {
    /* No per-request AbortController here (deliberately — see withDeadline's
       comment above): with the background refresher (refresher.js) keeping
       this cache warm, cache.get() normally returns an already-fresh value
       in well under a millisecond, without calling statsService.collect() at
       all. The only time this actually waits on a live collect() is a cold
       cache — freshly booted, or a sustained upstream outage past the stale
       window — and withDeadline bounds that wait so this route can never
       ride collect() all the way to nginx's proxy_read_timeout. */
    try {
      const { value, updatedAt } = await withDeadline(
        cache.get(() => statsService.collect()),
        config.statsWaitMs,
        () =>
          new StatsTimeoutError(
            `stats collection exceeded the ${config.statsWaitMs}ms wait budget`,
          ),
      )

      /* A degraded tile is invisible otherwise. collect() records a warning
         per failed source but still answers 200 — deliberately, so losing
         Blockscout cannot cost the market cap — which means a 5xx monitor
         will never fire even with every upstream down. Without this line the
         only signal that a source has been failing for hours is someone
         noticing a dash on the page. Logged once per collection rather than
         per request: responses are cached, so this fires on the refresher's
         cycle, not on visitor traffic. */
      if (value?.warnings?.length && updatedAt !== lastWarnedAt) {
        lastWarnedAt = updatedAt
        logger.warn?.('[coin/stats] degraded:', value.warnings.join('; '))
      }

      /* Let intermediaries cache for the same window we do, so a CDN in
         front of this absorbs the traffic instead of forwarding it. */
      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
      )
      res.json(toStatsPayload(value, updatedAt))
    } catch (err) {
      if (err instanceof StatsTimeoutError) {
        /* Cold start: nothing cached yet and collection is still running in
           the background (it will land in the cache for the next request —
           see withDeadline). Degrade honestly and promptly rather than
           making the visitor, and nginx, wait on it. */
        logger.warn?.(`[coin/stats] cold start: no cached value within ${config.statsWaitMs}ms`)
        return res.status(503).json({
          error: 'stats warming up',
          detail: 'no cached figures yet; try again shortly',
        })
      }

      logger.error?.('[coin/stats] all sources failed:', err.message)
      res.status(503).json({ error: 'stats unavailable', detail: err.message })
    }
  })

  /* Static content below — no upstream, no cache needed, editable by hand in
     content.js. See that file's header for why these five exist at all. */

  app.get('/coin/meta', (_req, res) => {
    res.json(coinMeta)
  })

  app.get('/coin/ticker', (_req, res) => {
    res.json(tickerFeed)
  })

  app.get('/gallery/categories', (_req, res) => {
    res.json(galleryCategories)
  })

  /* Mirrors D:\projects\tokenmeme2\src\api\mock\router.js's gallery case
     exactly: same filters (category, a needle matched against
     title/subtitle/caption), same pagination math, same envelope shape. */
  app.get('/gallery', (req, res) => {
    const category = req.query.category ? String(req.query.category) : 'all'
    const needle = String(req.query.search ?? '').trim().toLowerCase()
    const page = positiveIntParam(req.query.page, 1)
    const perPage = positiveIntParam(req.query.perPage, 24)

    const filtered = galleryItems.filter((item) => {
      const matchesCategory = category === 'all' || item.category === category
      const matchesSearch =
        !needle ||
        item.title.toLowerCase().includes(needle) ||
        item.subtitle.toLowerCase().includes(needle) ||
        item.caption.toLowerCase().includes(needle)
      return matchesCategory && matchesSearch
    })

    const start = (page - 1) * perPage
    res.json({
      items: filtered.slice(start, start + perPage),
      meta: {
        total: filtered.length,
        page,
        perPage,
        hasMore: start + perPage < filtered.length,
      },
    })
  })

  app.get('/gallery/:id', (req, res) => {
    const item = galleryItems.find((it) => it.id === req.params.id)
    if (!item) return res.status(404).json({ error: 'not found' })
    res.json(item)
  })

  app.use((_req, res) => res.status(404).json({ error: 'not found' }))

  return app
}
