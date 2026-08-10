import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildConfig,
  parseAddress,
  waitBudgetWarning,
  NGINX_PROXY_READ_TIMEOUT_MS,
} from '../src/config.js'

test('an unset address is null, not an error', () => {
  assert.equal(parseAddress('', 'TOKEN_ADDRESS'), null)
  assert.equal(parseAddress(undefined, 'TOKEN_ADDRESS'), null)
})

test('lowercases a checksummed address', () => {
  assert.equal(
    parseAddress('0xAbCdEf0123456789aBcDeF0123456789ABCDEF01', 'TOKEN_ADDRESS'),
    '0xabcdef0123456789abcdef0123456789abcdef01',
  )
})

test('rejects a malformed address with a message naming the variable', () => {
  assert.throws(() => parseAddress('0xnope', 'TOKEN_ADDRESS'), /TOKEN_ADDRESS/)
  assert.throws(
    () => parseAddress('105cca066775368454bf243d3dd4c623c7e6150c', 'TOKEN_ADDRESS'),
    /TOKEN_ADDRESS/,
  )
})

test('defaults are the Robinhood Chain endpoints', () => {
  const config = buildConfig({})
  assert.equal(config.rpcUrl, 'https://rpc.mainnet.chain.robinhood.com')
  assert.equal(config.blockscoutUrl, 'https://robinhoodchain.blockscout.com')
  assert.equal(config.dexscreenerUrl, 'https://api.dexscreener.com')
  assert.equal(config.port, 8787)
  assert.equal(config.tokenAddress, null)
})

test('strips a trailing slash from upstream URLs', () => {
  const config = buildConfig({ BLOCKSCOUT_URL: 'https://example.com/' })
  assert.equal(config.blockscoutUrl, 'https://example.com')
})

test('rejects a non-http upstream URL', () => {
  assert.throws(() => buildConfig({ RPC_URL: 'ftp://example.com' }), /RPC_URL/)
})

test('parses a comma-separated CORS allowlist', () => {
  const config = buildConfig({
    CORS_ORIGIN: 'http://localhost:5173, https://landwolfonhood.com/',
  })
  assert.deepEqual(config.corsOrigins, [
    'http://localhost:5173',
    'https://landwolfonhood.com',
  ])
})

test('supports a wildcard CORS origin', () => {
  assert.equal(buildConfig({ CORS_ORIGIN: '*' }).corsOrigins, '*')
})

test('rejects a non-integer port', () => {
  assert.throws(() => buildConfig({ PORT: 'abc' }), /PORT/)
})

test('background refresh interval and cold-start wait budget have sensible defaults', () => {
  const config = buildConfig({})
  assert.equal(config.refreshIntervalMs, 20000)
  assert.equal(config.statsWaitMs, 5000)
  assert.ok(
    config.refreshIntervalMs < config.cacheTtlMs,
    'the refresh interval must stay ahead of the cache TTL, or the cache goes stale between refreshes',
  )
})

test('REFRESH_INTERVAL_MS and STATS_WAIT_MS are configurable', () => {
  const config = buildConfig({ REFRESH_INTERVAL_MS: '5000', STATS_WAIT_MS: '1000' })
  assert.equal(config.refreshIntervalMs, 5000)
  assert.equal(config.statsWaitMs, 1000)
})

test('the snapshot path defaults under ./data and is configurable', () => {
  assert.equal(buildConfig({}).snapshotPath, './data/daily-snapshot.json')
  assert.equal(
    buildConfig({ SNAPSHOT_PATH: '/var/lib/wolf/snap.json' }).snapshotPath,
    '/var/lib/wolf/snap.json',
  )
})

/* The default config must not itself trip the warning — if it did, every
   operator would see it on every boot and learn to ignore the one message
   that prevents the donor project's twice-repeated outage from recurring
   here. */
test('the shipped defaults stay under nginx proxy_read_timeout', () => {
  const config = buildConfig({})
  assert.ok(config.statsWaitMs < NGINX_PROXY_READ_TIMEOUT_MS)
  assert.equal(waitBudgetWarning(config), null)
})

test('a stats wait budget at or over nginx proxy_read_timeout warns, naming both numbers', () => {
  const warning = waitBudgetWarning({ statsWaitMs: 20000 })
  assert.ok(warning, 'a 20s stats budget against a 15s ceiling must warn')
  assert.match(warning, /20000ms/)
  assert.match(warning, /15000ms/)
  assert.match(warning, /proxy_read_timeout/)
  assert.match(warning, /deploy\/nginx\.conf/)
})

/* Boundary: 'meets OR exceeds'. A budget exactly equal to the ceiling leaves
   zero margin for nginx's own overhead, so it warns. */
test('the warning fires exactly at the ceiling, not just above it', () => {
  const at = NGINX_PROXY_READ_TIMEOUT_MS
  assert.ok(waitBudgetWarning({ statsWaitMs: at }))
  assert.equal(waitBudgetWarning({ statsWaitMs: at - 1 }), null)
})

/* An operator who raises proxy_read_timeout in nginx is not doing anything
   wrong, and must be able to say so without the warning crying wolf. */
test('a raised ceiling silences the warning', () => {
  assert.ok(waitBudgetWarning({ statsWaitMs: 20000 }))
  assert.equal(waitBudgetWarning({ statsWaitMs: 20000 }, 30000), null)
})

/* Reads the real deploy/nginx.conf rather than asserting the constant equals
   itself. The whole failure mode this guards is two numbers drifting apart in
   two files, so a test that only looks at one file would reproduce the bug
   rather than catch it: change nginx to 10s and every other test here still
   passes while production silently 504s again. */
test('the mirrored ceiling matches proxy_read_timeout in deploy/nginx.conf', () => {
  const conf = readFileSync(
    new URL('../deploy/nginx.conf', import.meta.url),
    'utf8',
  )
  const match = conf.match(/proxy_read_timeout\s+(\d+)(m?s);/)
  assert.ok(match, 'deploy/nginx.conf must declare a proxy_read_timeout')
  const ms = match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1])
  assert.equal(
    NGINX_PROXY_READ_TIMEOUT_MS,
    ms,
    'NGINX_PROXY_READ_TIMEOUT_MS in config.js has drifted from deploy/nginx.conf — change both together',
  )
})
