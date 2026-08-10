/**
 * CONFIG
 * -----------------------------------------------------------------------------
 * Every environment-dependent value, parsed and validated once at startup.
 *
 * Validation is fail-fast and happens here rather than at the call site: a
 * malformed TOKEN_ADDRESS should stop the process with a clear message, not
 * surface hours later as an empty stats panel nobody can explain.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy). Everything
 * swap-related (RELAY_URL, SOLANA_RPC_URL, ALLOWED_CHAIN_IDS, MIN_TRADE_USD,
 * QUOTE_WAIT_MS, POOL_ADDRESS/WETH_ADDRESS for on-chain pool pricing) is
 * dropped: this backend serves three numbers, sourced from Blockscout and
 * Dexscreener plus four cheap RPC reads, never a Uniswap pool.
 */

import { readFileSync } from 'node:fs'

/**
 * Minimal .env loader.
 *
 * Hand-rolled rather than pulling in `dotenv`: this is thirty lines against a
 * dependency, and `node --env-file` is not an option because it hard-fails when
 * the file is absent, which is the normal case in a container where the values
 * come from the platform.
 *
 * Real environment variables always win, so a platform-injected value is never
 * clobbered by a stale .env left in the image.
 */
export function loadEnvFile(path = '.env', env = process.env) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return env // no file is fine — the platform supplies the values
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()

    // Strip one layer of matching quotes, so `FOO="bar baz"` yields `bar baz`.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }

    if (!(key in env)) env[key] = value
  }
  return env
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Validates an EVM address, returning it lowercased.
 *
 * Lowercasing matters: addresses arrive from multiple upstreams with
 * different capitalisations (Blockscout returns EIP-55 checksummed, the RPC
 * returns lowercase, Dexscreener mixes both), and a direct string comparison
 * against a configured address would otherwise silently fail.
 *
 * Returns null for an unset value — "not launched yet" is a valid state, not
 * an error. Anything set but malformed throws, because that is always a typo.
 */
export function parseAddress(value, name) {
  if (value == null || value === '') return null
  const trimmed = String(value).trim()
  if (!ADDRESS_RE.test(trimmed)) {
    throw new Error(
      `${name} must be a 0x-prefixed 40-hex-character address, got: ${trimmed}`,
    )
  }
  return trimmed.toLowerCase()
}

/** Strips any trailing slash so callers can join paths without doubling it. */
function parseUrl(value, fallback, name) {
  const raw = value == null || value === '' ? fallback : String(value).trim()
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid URL, got: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be http or https, got: ${raw}`)
  }
  return raw.replace(/\/+$/, '')
}

function parsePositiveInt(value, fallback, name) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`${name} must be a non-negative integer, got: ${value}`)
  }
  return n
}

/**
 * Parses the CORS allowlist.
 *
 * `*` is a deliberate, supported choice here rather than a lax default: every
 * route this server answers is public read-only data with no credentials and
 * no side effects, so there is nothing for a cross-origin caller to abuse.
 */
function parseOrigins(value) {
  const raw = (value ?? '').trim()
  if (raw === '') return []
  if (raw === '*') return '*'
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** Builds the frozen config object. Throws on any invalid value. */
export function buildConfig(env = process.env) {
  return Object.freeze({
    tokenAddress: parseAddress(env.TOKEN_ADDRESS, 'TOKEN_ADDRESS'),

    rpcUrl: parseUrl(
      env.RPC_URL,
      'https://rpc.mainnet.chain.robinhood.com',
      'RPC_URL',
    ),
    blockscoutUrl: parseUrl(
      env.BLOCKSCOUT_URL,
      'https://robinhoodchain.blockscout.com',
      'BLOCKSCOUT_URL',
    ),
    dexscreenerUrl: parseUrl(
      env.DEXSCREENER_URL,
      'https://api.dexscreener.com',
      'DEXSCREENER_URL',
    ),

    port: parsePositiveInt(env.PORT, 8787, 'PORT'),

    /* Loopback by default. Behind nginx there is no reason to accept traffic on
       the public interface, and binding 0.0.0.0 means a missing firewall rule
       silently exposes the app port alongside the proxied one. Override to
       0.0.0.0 only for a container that is itself the network boundary. */
    host: (env.HOST ?? '127.0.0.1').trim(),
    corsOrigins: parseOrigins(env.CORS_ORIGIN ?? 'http://localhost:5173'),

    cacheTtlMs: parsePositiveInt(env.CACHE_TTL_MS, 30_000, 'CACHE_TTL_MS'),
    staleMaxMs: parsePositiveInt(env.STALE_MAX_MS, 600_000, 'STALE_MAX_MS'),
    upstreamTimeoutMs: parsePositiveInt(
      env.UPSTREAM_TIMEOUT_MS,
      8_000,
      'UPSTREAM_TIMEOUT_MS',
    ),

    /* How often the background refresher (src/refresher.js) re-collects stats
       and writes them into the cache. Kept below cacheTtlMs so the timer, not
       an inbound request, is almost always what pays collect()'s latency. */
    refreshIntervalMs: parsePositiveInt(
      env.REFRESH_INTERVAL_MS,
      20_000,
      'REFRESH_INTERVAL_MS',
    ),

    /* Caps how long GET /coin/stats will wait on a cold cache (nothing
       collected yet) before degrading to a 503 rather than hanging.
       Deliberately well under both collect()'s worst case (one
       upstreamTimeoutMs, since every upstream call runs concurrently — see
       stats.js) and nginx's proxy_read_timeout — see waitBudgetWarning()
       below. This is the ONLY wait budget this backend has: there is no
       /quote here, and the donor's twice-repeated 504 outage was always a
       second, sequential wait budget composing on top of this one. Losing
       that second budget entirely is a feature, not a simplification to
       regret. */
    statsWaitMs: parsePositiveInt(env.STATS_WAIT_MS, 5_000, 'STATS_WAIT_MS'),

    /* Where the once-a-day holders/burned snapshot is written — see
       snapshot.js. A flat JSON file, not a database: one write a day, a few
       dozen bytes, and one fewer service to run on the droplet. */
    snapshotPath: (env.SNAPSHOT_PATH ?? './data/daily-snapshot.json').trim(),
  })
}

/* Mirrors `proxy_read_timeout` in deploy/nginx.conf. Duplicated here on
   purpose: nginx's config is not readable from Node, and the whole point of
   the check below is that these two numbers live in different files and — in
   the donor project this backend is ported from — twice drifted apart into a
   504 outage. Change both together. */
export const NGINX_PROXY_READ_TIMEOUT_MS = 15_000

/**
 * Returns a warning string when the stats wait budget outlives nginx's read
 * timeout, or null when the config is safe.
 *
 * The donor project (d:\projects\ponsy) had the SAME outage twice: a wait
 * budget that outlived nginx's proxy_read_timeout, so nginx returned a 504
 * over a request that was about to succeed. Both times the composition was
 * only visible by reading two files nobody reads together — an env var here
 * and a directive in deploy/nginx.conf. This backend has only one wait
 * budget (statsWaitMs — there is no /quote route to add a second), but the
 * check itself is exactly as load-bearing: it is the one thing standing
 * between a future config change and a third recurrence of the same bug.
 *
 * Warns rather than throws: Node cannot read nginx's config, and an operator
 * who has genuinely raised proxy_read_timeout is not doing anything wrong.
 * Refusing to boot over that assumption would be worse than the outage it
 * prevents. The message carries the actual numbers and names the file to
 * change, because the failure it prevents is silent, intermittent, and reads
 * like an upstream problem rather than a config one.
 *
 * A pure function returning a string rather than a console.warn() inside the
 * listen callback, so this safety net is testable.
 */
export function waitBudgetWarning(config, ceilingMs = NGINX_PROXY_READ_TIMEOUT_MS) {
  const budget = config.statsWaitMs
  if (budget < ceilingMs) return null
  return (
    `a wait budget of ${budget}ms meets or exceeds the ${ceilingMs}ms ` +
    `proxy_read_timeout in deploy/nginx.conf. nginx will 504 before this ` +
    `server answers. Lower STATS_WAIT_MS, or raise proxy_read_timeout to ` +
    `match.`
  )
}
