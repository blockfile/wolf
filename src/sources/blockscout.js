/**
 * BLOCKSCOUT
 * -----------------------------------------------------------------------------
 * The one thing only Blockscout can tell us: how many addresses hold this
 * token. There is no way to ask a plain RPC node that — answering it means
 * replaying every Transfer log since deployment and tracking balances, which
 * is precisely the indexing work the explorer already does. Reimplementing
 * it here would mean a database and a backfill for one integer.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy), trimmed to
 * fetchHolders. fetchNativeUsd and fetchToken are dropped: this backend never
 * prices anything on-chain (no Uniswap pool read — see stats.js), so there is
 * no ETH/USD conversion to feed, and the RPC is always available for supply
 * and decimals so the token-metadata fallback has nothing to fall back for.
 */

import { getJson, toNumber } from '../http.js'

/**
 * Holder count for an ERC-20.
 *
 * Uses /counters rather than the fuller /tokens/{addr} payload: it returns the
 * same figure from a cheaper query, and we need none of the other fields.
 */
export async function fetchHolders(baseUrl, tokenAddress, opts = {}) {
  const url = `${baseUrl}/api/v2/tokens/${tokenAddress}/counters`
  const json = await getJson(url, opts)

  const holders = toNumber(json?.token_holders_count)
  if (holders == null) {
    throw new Error(`Blockscout returned no token_holders_count for ${tokenAddress}`)
  }
  return holders
}
