/**
 * FIXTURES
 * -----------------------------------------------------------------------------
 * Synthetic upstream shapes for exercising $WOLF's stats pipeline.
 *
 * IMPORTANT: unlike the donor project (which had a real, verified $BRETT
 * contract to test against), Land of Wolf's real contract address has not
 * been provided yet — see .env.example and src/content.js. Nothing here is
 * "verified on-chain" data. TOKEN_ADDRESS below is a well-known placeholder
 * pattern (0x1234...), not a real deployed contract; the returndata,
 * holder count, price and market cap are arbitrary but internally
 * consistent numbers chosen purely to exercise the arithmetic in
 * abi.js/decimals.js/stats.js. Do not copy any of these values into
 * .env.example or src/content.js believing them to be real.
 *
 * A second, nonzero burn balance (DEAD_BALANCE_NONZERO_RETURNDATA) is
 * included purely for exercising the burn math with a real percentage — the
 * "happy path" fixtures below use zero burned, and tests that want a
 * nonzero burnedPct opt into the other one explicitly.
 *
 * Returndata bytes are computed, not hand-invented, for the same reason the
 * PONSY donor's fixtures.js gives for itself: hand-written hex tends to
 * encode the author's belief about the layout, which is the very thing under
 * test. These are computed with the same BigInt arithmetic abi.js/decimals.js
 * use, not typed out by hand.
 */

/** Placeholder-pattern address (not a real deployed contract) used only to
    exercise the pipeline in tests. */
export const TOKEN_ADDRESS = '0x1234567890123456789012345678901234567890'

/** totalSupply() -> 1e27 raw = 1,000,000,000 whole tokens at 18 decimals.
    An arbitrary, commonly-used round supply for test purposes — not a real
    verified $WOLF figure. */
export const TOTAL_SUPPLY_RETURNDATA =
  '0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000'

/** decimals() -> 18 */
export const DECIMALS_18_RETURNDATA =
  '0x0000000000000000000000000000000000000000000000000000000000000012'

/** The two conventional burn sinks. Mirrors the constants in src/stats.js. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** balanceOf(dead|zero) -> 0. The "nothing burned yet" happy path used by
    most tests below. */
export const ZERO_BALANCE_RETURNDATA =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

/** balanceOf(dead) -> 12,345 * 1e18, used only by tests that want a real,
    nonzero burnedPct to check the arithmetic against. */
export const DEAD_BALANCE_NONZERO_RETURNDATA =
  '0x00000000000000000000000000000000000000000000029d394a5d6305440000'

/** balanceOf(zero) -> 500 * 1e18, used to prove burned sums BOTH sinks
    (0x...dEaD AND 0x0), not just the dead address. */
export const ZERO_BALANCE_NONZERO_RETURNDATA =
  '0x00000000000000000000000000000000000000000000001b1ae4d6e2ef500000'

/** GET /api/v2/tokens/{addr}/counters */
export const BLOCKSCOUT_COUNTERS = {
  token_holders_count: '118',
  transfers_count: '412',
}

/** GET /latest/dex/tokens/{addr} — pair robinhood/uniswap. Synthetic fixture
    data, not a real indexed pair. */
export const DEXSCREENER_TOKENS = {
  schemaVersion: '1.0.0',
  pairs: [
    {
      chainId: 'robinhood',
      dexId: 'uniswap',
      pairAddress: '0x9F2e1B4c8A6d7E3f5C0b1A2d3E4f5061728394A',
      baseToken: { address: TOKEN_ADDRESS, name: 'Land of Wolf', symbol: 'WOLF' },
      quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', name: 'WETH', symbol: 'WETH' },
      priceNative: '0.0000000155',
      priceUsd: '0.00002986',
      liquidity: { usd: 14200.5, base: 475000000, quote: 4.71 },
      priceChange: { m5: 2.1, h1: 18.4, h6: 210.7, h24: 978 },
      fdv: 29863,
      marketCap: 29863,
    },
  ],
}

/**
 * A fake `fetch` driven by a routing table.
 *
 * Each entry is [substring-of-url, handler]. The handler returns either a plain
 * object (becomes a 200 JSON response) or throws (becomes a network failure).
 */
export function stubFetch(routes) {
  const calls = []

  async function fetchImpl(url, init = {}) {
    const href = String(url)
    calls.push({ url: href, init })

    for (const [match, handler] of routes) {
      if (!href.includes(match)) continue

      const body = init.body ? JSON.parse(init.body) : null
      const result = await handler(body, href)

      if (result instanceof Error) throw result
      if (result?.__status && result.__status >= 400) {
        const { __status, ...rest } = result
        return { ok: false, status: __status, json: async () => rest }
      }
      return { ok: true, status: 200, json: async () => result }
    }
    throw new Error(`stubFetch: no route matched ${href}`)
  }

  fetchImpl.calls = calls
  return fetchImpl
}

/** Builds a JSON-RPC batch reply for the given per-call returndata. */
export function rpcBatchReply(requests, returndataByIndex) {
  return requests.map((req, i) => {
    const data = returndataByIndex[i]
    if (data instanceof Error) {
      return { jsonrpc: '2.0', id: req.id, error: { message: data.message } }
    }
    return { jsonrpc: '2.0', id: req.id, result: data }
  })
}
