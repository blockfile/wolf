#!/usr/bin/env node
/**
 * PROBE
 * -----------------------------------------------------------------------------
 * Checks each upstream independently and prints what it returned.
 *
 * Exists because /coin/stats deliberately degrades quietly: when a source is
 * down you get a null field and a warning, not a stack trace. That is right
 * for the website and useless for diagnosis, so this walks the same path
 * with the failures made loud.
 *
 * Ported from the PONSY stats backend (donor: d:\projects\ponsy), trimmed to
 * the upstreams this backend actually calls — no pool, no ETH/USD.
 *
 *   npm run probe
 */

import { loadEnvFile, buildConfig } from '../src/config.js'
import { createRpcClient } from '../src/chain/rpc.js'
import { SELECTORS, decodeUint, decodeUint8, encodeBalanceOf } from '../src/chain/abi.js'
import { toWholeTokens } from '../src/chain/decimals.js'
import * as blockscout from '../src/sources/blockscout.js'
import * as dexscreener from '../src/sources/dexscreener.js'

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

loadEnvFile()
const config = buildConfig()

const ok = (label, value) => console.log(`  ok    ${label.padEnd(22)} ${value}`)
const bad = (label, err) => console.log(`  FAIL  ${label.padEnd(22)} ${err.message}`)

async function step(label, fn) {
  try {
    ok(label, await fn())
    return true
  } catch (err) {
    bad(label, err)
    return false
  }
}

console.log(`\nRPC          ${config.rpcUrl}`)
console.log(`Explorer     ${config.blockscoutUrl}`)
console.log(`Dexscreener  ${config.dexscreenerUrl}`)
console.log(`Token        ${config.tokenAddress ?? '(unset)'}\n`)

if (!config.tokenAddress) {
  console.log('  TOKEN_ADDRESS is unset — /coin/stats will return nulls.')
  console.log('  Set it in .env to check the token-specific sources.\n')
  process.exit(0)
}

const rpc = createRpcClient({ url: config.rpcUrl, timeoutMs: config.upstreamTimeoutMs })
const opts = { timeoutMs: config.upstreamTimeoutMs }

await step('holders', async () =>
  await blockscout.fetchHolders(config.blockscoutUrl, config.tokenAddress, opts),
)

await step('supply + burned', async () => {
  const [supplyData, decimalsData, deadData, zeroData] = await rpc.ethCallBatch([
    { to: config.tokenAddress, data: SELECTORS.totalSupply },
    { to: config.tokenAddress, data: SELECTORS.decimals },
    { to: config.tokenAddress, data: encodeBalanceOf(DEAD_ADDRESS) },
    { to: config.tokenAddress, data: encodeBalanceOf(ZERO_ADDRESS) },
  ])
  const decimals = decodeUint8(decimalsData)
  const supply = toWholeTokens(decodeUint(supplyData), decimals)
  const burned = toWholeTokens(decodeUint(deadData) + decodeUint(zeroData), decimals)
  const burnedPct = supply > 0 ? (burned / supply) * 100 : null
  return `supply ${supply.toLocaleString('en-US')} (${decimals} decimals), burned ${burned.toLocaleString('en-US')} (${burnedPct?.toFixed(4)}%)`
})

await step('dexscreener', async () => {
  const q = await dexscreener.fetchPrice(config.dexscreenerUrl, config.tokenAddress, opts)
  return `$${q.priceUsd} · mcap $${q.marketCap ?? 'n/a'} · 24h ${q.priceChange24h ?? 'n/a'}% · liquidity $${q.liquidityUsd}`
})

console.log('')
