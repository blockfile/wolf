/**
 * DECIMAL SCALING
 * -----------------------------------------------------------------------------
 * Converts a raw on-chain uint256 (totalSupply, a balance) into a whole-token
 * JS number.
 *
 * Split out of the donor's chain/uniswapV3.js (d:\projects\ponsy): that file
 * mixed this generic decimal-scaling helper with Uniswap v3 sqrtPriceX96
 * price math. This backend's market cap comes from Dexscreener only (see
 * stats.js; there is no on-chain pool read), so the price math has no reason
 * to exist here — but supply and burn-balance scaling still does, so it gets
 * its own small file instead of being dropped along with the rest of that one.
 */

/**
 * Whole-token amount from a raw on-chain uint256.
 *
 * Kept in BigInt until the final division: a 1e27-range raw supply is already
 * past Number's exact-integer range, so converting first and dividing after
 * would quietly lose the low digits.
 */
export function toWholeTokens(rawAmount, decimals) {
  if (typeof rawAmount !== 'bigint') {
    throw new TypeError('rawAmount must be a bigint')
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`decimals must be an integer in 0..77, got ${decimals}`)
  }
  const scale = 10n ** BigInt(decimals)
  const whole = rawAmount / scale
  const remainder = rawAmount % scale
  return Number(whole) + Number(remainder) / Number(scale)
}
