/**
 * ENTRY POINT
 * -----------------------------------------------------------------------------
 * Loads config, wires the pieces together, starts listening.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy), minus the
 * Solana blockhash provider and quote service — this backend serves three
 * numbers plus static content, never a swap.
 */

import { loadEnvFile, buildConfig, waitBudgetWarning } from './config.js'
import { createRpcClient } from './chain/rpc.js'
import { createStatsService } from './stats.js'
import { createSnapshotStore } from './snapshot.js'
import { createCache } from './cache.js'
import { createRefresher } from './refresher.js'
import { createServer } from './server.js'

loadEnvFile()

let config
try {
  config = buildConfig()
} catch (err) {
  /* Fail here, loudly, rather than starting a server that can only ever answer
     with errors. A typo'd address should cost you a startup log line, not an
     afternoon of wondering why the panel is blank. */
  console.error(`[config] ${err.message}`)
  process.exit(1)
}

const rpc = createRpcClient({
  url: config.rpcUrl,
  timeoutMs: config.upstreamTimeoutMs,
})

const snapshotStore = createSnapshotStore({ path: config.snapshotPath })
const statsService = createStatsService({ config, rpc, snapshotStore })
const cache = createCache({
  ttlMs: config.cacheTtlMs,
  staleMaxMs: config.staleMaxMs,
})

/* Keeps the stats cache warm on a timer so GET /coin/stats can answer from
   memory instead of waiting on an upstream — see refresher.js. Started
   explicitly (never auto-starts) and stopped on shutdown below, so it never
   runs in tests and never outlives the process. */
const refresher = createRefresher({
  cache,
  statsService,
  intervalMs: config.refreshIntervalMs,
})

const app = createServer({ config, statsService, cache })

/* Start warming the cache before the server can accept a single connection,
   so the earliest possible request has the best chance of finding a refresh
   already in flight (or, after the first cycle, already sitting in cache)
   instead of paying collect()'s latency itself. This is also what makes the
   once-a-day snapshot write happen on a schedule independent of traffic —
   see snapshot.js and stats.js's collect(): a quiet server with zero
   visitors still gets its daily snapshot, because the refresher calls
   collect() on its own regardless. */
refresher.start()

const server = app.listen(config.port, config.host, () => {
  console.log(`[wolf-stats] listening on ${config.host}:${config.port}`)
  console.log(`[wolf-stats] rpc        ${config.rpcUrl}`)
  console.log(`[wolf-stats] explorer   ${config.blockscoutUrl}`)
  console.log(`[wolf-stats] dexscreener ${config.dexscreenerUrl}`)
  console.log(`[wolf-stats] refresh    every ${config.refreshIntervalMs}ms`)
  console.log(`[wolf-stats] snapshot   ${config.snapshotPath}`)
  console.log(
    `[wolf-stats] token      ${config.tokenAddress ?? 'UNSET — /coin/stats returns nulls until you set TOKEN_ADDRESS'}`,
  )
  console.log(`[wolf-stats] waits      stats ${config.statsWaitMs}ms`)

  /* See waitBudgetWarning() in config.js for why this warns rather than
     throws, and why the check lives there rather than inline here. */
  const warning = waitBudgetWarning(config)
  if (warning) console.warn(`[wolf-stats] WARNING: ${warning}`)
})

/* Containers stop with SIGTERM; without this the platform waits out its grace
   period on every deploy. Stopping the refresher here too, not just the
   server, is what keeps this timer from leaking past shutdown. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[wolf-stats] ${signal} — shutting down`)
    refresher.stop()
    server.close(() => process.exit(0))
  })
}
