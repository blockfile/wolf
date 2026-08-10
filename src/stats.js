/**
 * STATS ORCHESTRATION
 * -----------------------------------------------------------------------------
 * Composes the three /coin/stats tiles from Blockscout, the RPC and
 * Dexscreener, and decides what to do when any one of them is unavailable.
 *
 * The governing rule, carried over from the donor: never invent a number.
 * Every field is either a figure actually derived or null, and `source`
 * always records where it came from. A wrong market cap on a token site is
 * worse than a missing one — people make buying decisions on it.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy). The
 * load-bearing property carried over unchanged: every upstream call this
 * function makes goes into ONE Promise.allSettled group, never a sequential
 * fallback after it. Both of the donor's production 504 outages were a
 * second upstream call composing sequentially on top of the first, past
 * nginx's proxy_read_timeout — see config.js's waitBudgetWarning. This
 * backend has fewer upstreams than the donor (no on-chain pool price, no
 * ETH/USD conversion — see sources/dexscreener.js), which only makes it
 * easier to keep that promise, not less important to state it.
 */

import { SELECTORS, decodeUint, decodeUint8, encodeBalanceOf } from './chain/abi.js'
import { toWholeTokens } from './chain/decimals.js'
import * as blockscout from './sources/blockscout.js'
import * as dexscreener from './sources/dexscreener.js'
import { relativeDeltaPct, pointDelta } from './snapshot.js'

/* The two conventional burn sinks. Summed because a plain ERC-20 with no
   burn() has no other way to remove tokens from supply. 0x0 typically holds
   nothing for a token before launch, but the read is free (one more slot in
   the batch already being sent) and skipping it would silently miss a
   transfer there. */
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Reads supply, decimals and the burned balance in one round trip.
 *
 * @returns {Promise<{ supply: number, decimals: number, burned: number|null,
 *   burnedPct: number|null, burnWarning: string|null }>}
 */
async function readChain({ rpc, config, signal }) {
  /* All four reads ride this ONE batch, not a second call — a sequential
     upstream call composing past nginx's proxy_read_timeout is the exact
     mistake the donor project's two outages came from (see config.js). */
  const calls = [
    { to: config.tokenAddress, data: SELECTORS.totalSupply }, // 0
    { to: config.tokenAddress, data: SELECTORS.decimals }, // 1
    { to: config.tokenAddress, data: encodeBalanceOf(DEAD_ADDRESS) }, // 2
    { to: config.tokenAddress, data: encodeBalanceOf(ZERO_ADDRESS) }, // 3
  ]

  const results = await rpc.ethCallBatch(calls, { signal })

  const rawSupply = decodeUint(results[0])
  const decimals = decodeUint8(results[1])
  const supply = toWholeTokens(rawSupply, decimals)

  /* Decoding the burn words is isolated from the totalSupply/decimals decode
     above: those two already succeeded by the time we get here, so a bad
     burn word (e.g. truncated returndata) must not take marketCap and
     holders down with it. Caught here, not left to propagate, exactly so
     collect() can still build a market cap from `supply`. */
  let burned = null
  let burnedPct = null
  let burnWarning = null
  try {
    const rawDead = decodeUint(results[2])
    const rawZero = decodeUint(results[3])
    burned = toWholeTokens(rawDead + rawZero, decimals)
    // Guard the division: a zero supply must not put Infinity/NaN in the JSON.
    burnedPct = supply > 0 ? (burned / supply) * 100 : null
  } catch (err) {
    burnWarning = `burn read failed: ${err.message}`
  }

  return { supply, decimals, burned, burnedPct, burnWarning }
}

/**
 * Builds the stats service.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.rpc              createRpcClient instance
 * @param {Function} [deps.fetchImpl]
 * @param {object} [deps.snapshotStore]  createSnapshotStore instance (snapshot.js).
 *   Optional so tests that do not care about deltas can omit it; omitting it
 *   in production would just mean every delta reads 0, the honest answer
 *   with nothing to diff against anyway.
 */
export function createStatsService({ config, rpc, fetchImpl = fetch, snapshotStore = null }) {
  const httpOpts = { timeoutMs: config.upstreamTimeoutMs, fetchImpl }

  /**
   * Produces one complete stats payload.
   */
  async function collect({ signal } = {}) {
    if (!config.tokenAddress) {
      /* Pre-launch. A successful response with null figures, not an error —
         mirrors the donor's placeholder behaviour and the same reasoning:
         the frontend renders null as an em dash (src/lib/format.js), whereas
         an error trips the RETRY panel and tells visitors the site is broken
         when it is merely early. */
      return {
        marketCap: null,
        holders: null,
        burnedPct: null,
        priceChange24h: null,
        holdersDelta: 0,
        burnedDelta: 0,
        totalSupply: null,
        burned: null,
        placeholder: true,
        source: { marketCap: 'none', holders: 'none' },
        warnings: ['TOKEN_ADDRESS is not set'],
      }
    }

    const opts = { ...httpOpts, signal }
    const warnings = []

    /* All three fetched together and settled independently — see this
       module's header comment for why that is the one property that must
       never regress. */
    const [holdersRes, chainRes, dexRes] = await Promise.allSettled([
      blockscout.fetchHolders(config.blockscoutUrl, config.tokenAddress, opts),
      readChain({ rpc, config, signal }),
      dexscreener.fetchPrice(config.dexscreenerUrl, config.tokenAddress, opts),
    ])

    let holders = null
    let holdersSource = 'none'
    if (holdersRes.status === 'fulfilled') {
      holders = holdersRes.value
      holdersSource = 'blockscout'
    } else {
      warnings.push(`holders unavailable: ${holdersRes.reason?.message}`)
    }

    const chain = chainRes.status === 'fulfilled' ? chainRes.value : null
    if (!chain) warnings.push(`chain read failed: ${chainRes.reason?.message}`)

    const dex = dexRes.status === 'fulfilled' ? dexRes.value : null
    if (!dex) warnings.push(`dexscreener unavailable: ${dexRes.reason?.message}`)

    let marketCap = null
    let marketCapSource = 'none'
    if (dex?.marketCap != null) {
      marketCap = dex.marketCap
      marketCapSource = 'dexscreener-marketCap'
    } else if (dex?.priceUsd != null && chain?.supply != null) {
      marketCap = dex.priceUsd * chain.supply
      marketCapSource = 'priceUsd-times-totalSupply'
    } else {
      warnings.push('market cap could not be derived')
    }

    const priceChange24h = dex?.priceChange24h ?? null

    const totalSupply = chain?.supply ?? null
    const burned = chain?.burned ?? null
    const burnedPct = chain?.burnedPct ?? null
    /* Degrades independently of marketCap/holders: a chain-read outage
       already produced the "chain read failed" warning above, so this only
       fires for the narrower case of the chain read succeeding while the
       burn words specifically failed to decode. */
    if (chain && burned == null) warnings.push(chain.burnWarning)

    /* Deltas: mcap's is real and free (Dexscreener's own priceChange.h24,
       already resolved above). Holders and burned have no upstream history
       at all, so they come from the once-a-day snapshot file instead — see
       snapshot.js. Reading it, and diffing against it, must never fail this
       request: wrapped in try/catch here as a second line of defence on top
       of snapshotStore.read()'s own internal guard, and relativeDeltaPct /
       pointDelta both treat a missing previous value as "nothing to diff
       against yet" -> 0. */
    let holdersDelta = 0
    let burnedDelta = 0
    if (snapshotStore) {
      let previous = null
      try {
        previous = await snapshotStore.read()
      } catch {
        previous = null
      }
      holdersDelta = relativeDeltaPct(holders, previous?.holders)
      burnedDelta = pointDelta(burnedPct, previous?.burnedPct)

      /* Write today's figures once the UTC day has rolled over since the
         last write — never awaited, so a full disk or slow filesystem
         cannot add latency to (let alone fail) the request that happened to
         trigger it. snapshotStore.write() already swallows its own errors
         (see snapshot.js); the .catch here is a second line of defence in
         case a caller-injected store does not. */
      if (previous?.date !== snapshotStore.todayKey()) {
        Promise.resolve(snapshotStore.write({ holders, burnedPct })).catch(() => {})
      }
    }

    return {
      marketCap,
      holders,
      burnedPct,
      priceChange24h,
      holdersDelta,
      burnedDelta,
      totalSupply,
      burned,
      placeholder: false,
      source: { marketCap: marketCapSource, holders: holdersSource },
      warnings,
    }
  }

  return { collect }
}
