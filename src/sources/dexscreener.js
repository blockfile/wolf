/**
 * DEXSCREENER — the market cap source
 * -----------------------------------------------------------------------------
 * Dexscreener indexes Robinhood Chain under the chain id "robinhood"
 * (verified 2026-08-08, PONSY donor project). This backend expects
 * $WOLF's pair to be indexed the same way once the token launches and
 * Dexscreener picks it up — see selectPair() below.
 *
 * Unlike the PONSY donor (d:\projects\ponsy), this is not a fallback behind
 * an on-chain pool read — it is the only price source. There is no
 * POOL_ADDRESS here and no Uniswap v3 pool math (see stats.js and the
 * removed chain/uniswapV3.js): Dexscreener publishes `marketCap` directly for
 * an indexed pair, which is both simpler and more authoritative than
 * recomputing it from priceUsd x totalSupply — that product is only the
 * fallback, for the (normal, expected) case where Dexscreener has priced the
 * pair but not yet attached a marketCap figure to it.
 */

import { getJson, toNumber } from '../http.js'

/** Dexscreener's identifier for Robinhood Chain. */
export const DEX_CHAIN_ID = 'robinhood'

/**
 * Picks the pair a price should be read from.
 *
 * Two filters matter:
 *
 *   chainId    — the same address can exist on another chain, and pricing our
 *                token off a namesake elsewhere is worse than no price at all.
 *
 *   baseToken  — Dexscreener's `priceUsd` (and `marketCap`) are always about
 *                `baseToken`. When our token is the *quote* side of a pair,
 *                those figures describe something else entirely.
 *
 * Of what survives, the deepest pool wins: a thin pair's price moves on dust.
 */
export function selectPair(pairs, tokenAddress, chainId = DEX_CHAIN_ID) {
  if (!Array.isArray(pairs)) return null
  const wanted = tokenAddress.toLowerCase()

  const eligible = pairs.filter(
    (p) =>
      p?.chainId === chainId &&
      p?.baseToken?.address?.toLowerCase() === wanted &&
      toNumber(p?.priceUsd) != null,
  )
  if (eligible.length === 0) return null

  return eligible.reduce((best, p) =>
    (toNumber(p?.liquidity?.usd) ?? 0) > (toNumber(best?.liquidity?.usd) ?? 0) ? p : best,
  )
}

/**
 * Price and market data for a token.
 *
 * `marketCap` and `priceChange24h` are null, not thrown, when Dexscreener has
 * not populated those specific fields on an otherwise-valid pair — stats.js
 * falls back to priceUsd x totalSupply for the former, and null propagates
 * harmlessly to a `0`-rendering ("flat") delta for the latter.
 *
 * @returns {Promise<{
 *   priceUsd: number,
 *   liquidityUsd: number|null,
 *   pairAddress: string|null,
 *   marketCap: number|null,
 *   priceChange24h: number|null,
 * }>}
 */
export async function fetchPrice(baseUrl, tokenAddress, opts = {}) {
  const url = `${baseUrl}/latest/dex/tokens/${tokenAddress}`
  const json = await getJson(url, opts)

  const pair = selectPair(json?.pairs, tokenAddress, opts.chainId ?? DEX_CHAIN_ID)
  if (!pair) {
    throw new Error(`Dexscreener has no indexed pair for ${tokenAddress}`)
  }

  const priceUsd = toNumber(pair.priceUsd)
  if (priceUsd == null || priceUsd <= 0) {
    throw new Error(`Dexscreener returned no usable priceUsd for ${tokenAddress}`)
  }

  return {
    priceUsd,
    liquidityUsd: toNumber(pair?.liquidity?.usd),
    pairAddress: pair?.pairAddress ?? null,
    marketCap: toNumber(pair?.marketCap),
    priceChange24h: toNumber(pair?.priceChange?.h24),
  }
}
