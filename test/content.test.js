import test from 'node:test'
import assert from 'node:assert/strict'

import { coinMeta, tickerFeed, galleryCategories, galleryItems } from '../src/content.js'
import { parseAddress } from '../src/config.js'

test('coinMeta.contract is an obvious placeholder, not a real address and not left over from another token', () => {
  // The real $WOLF contract has not been provided yet (see .env.example).
  // Rather than invent an address, coinMeta.contract carries a human-readable
  // sentinel that unmistakably still needs filling in. parseAddress is the
  // same 0x-format validator config.js uses for TOKEN_ADDRESS — asserting it
  // does NOT parse as an address here proves this value cannot be mistaken
  // for a real, launched contract.
  assert.equal(coinMeta.contract, 'SET_CONTRACT_ADDRESS_BEFORE_LAUNCH')
  assert.throws(() => parseAddress(coinMeta.contract, 'coinMeta.contract'))
  assert.notEqual(coinMeta.contract, '0x105cca066775368454bf243d3dd4c623c7e6150c', 'must not be the donor $BRETT contract')
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
