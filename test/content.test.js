import test from 'node:test'
import assert from 'node:assert/strict'

import { coinMeta, tickerFeed, galleryCategories, galleryItems } from '../src/content.js'
import { parseAddress } from '../src/config.js'

test('coinMeta.contract is the verified LANDWOLF address, and no other token', () => {
  /* Verified on-chain 2026-08-11 against rpc.mainnet.chain.robinhood.com:
     symbol LANDWOLF, name "Landwolf on Hood", 18 decimals, 1,000,000,000
     supply. It matches the address the site itself hard-codes in
     src/config/token.js (D:\projects\tokenmeme1) — the two must agree, or
     the copy button hands out one token while the tiles price another.

     Pinned exactly rather than merely "parses as an address". The failure
     this guards is not a malformed value; it is a well-formed address for
     the WRONG token, which no format check can catch and which would put
     another project's market cap under this brand. */
  assert.equal(coinMeta.contract, '0x8907ece9cbba1e2766263b3b5126ec65ab3ff77c')

  // Parses as a real 0x address, by the same validator config.js applies to
  // TOKEN_ADDRESS.
  assert.doesNotThrow(() => parseAddress(coinMeta.contract, 'coinMeta.contract'))

  // The two wrong-token states this repo could plausibly regress into.
  assert.notEqual(coinMeta.contract, '0x105cca066775368454bf243d3dd4c623c7e6150c', 'must not be the donor $BRETT contract')
  assert.notEqual(coinMeta.contract, 'SET_CONTRACT_ADDRESS_BEFORE_LAUNCH', 'the pre-launch sentinel must not survive into production')
})

test('coinMeta identifies Land of Wolf, not the donor project', () => {
  assert.equal(coinMeta.ticker, 'WOLF')
  assert.equal(coinMeta.name, 'Land of Wolf')
})

test('coinMeta carries the fields the identity panel reads', () => {
  for (const key of ['ticker', 'name', 'tagline', 'blurb', 'chain', 'contract', 'socials', 'buyUrl', 'chartUrl']) {
    assert.ok(key in coinMeta, `coinMeta must carry ${key}`)
  }
  assert.ok(Array.isArray(coinMeta.socials) && coinMeta.socials.length > 0)
})

test('tickerFeed has a bpm and a nonempty list of marquee lines', () => {
  assert.equal(typeof tickerFeed.bpm, 'number')
  assert.ok(Array.isArray(tickerFeed.lines) && tickerFeed.lines.length > 0)
  for (const line of tickerFeed.lines) assert.equal(typeof line, 'string')
})

test('galleryCategories always includes "all"', () => {
  assert.ok(galleryCategories.some((c) => c.id === 'all'))
})

test('every gallery item has a unique id and belongs to a real category', () => {
  const categoryIds = new Set(galleryCategories.map((c) => c.id))
  const seen = new Set()
  for (const item of galleryItems) {
    assert.ok(!seen.has(item.id), `duplicate gallery id ${item.id}`)
    seen.add(item.id)
    assert.ok(categoryIds.has(item.category), `${item.id} has an unknown category ${item.category}`)
  }
})
