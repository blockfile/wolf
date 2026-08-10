/**
 * STATIC CONTENT
 * -----------------------------------------------------------------------------
 * Everything /coin/meta, /coin/ticker, /gallery, /gallery/categories and
 * /gallery/:id serve. None of it is live data — it mirrors the frontend's own
 * fixtures (D:\projects\tokenmeme2\src\api\mock\identity.js, stats.js's
 * tickerFeed, and data.js) so that turning VITE_USE_MOCK_API off is a
 * same-shape swap, not a redesign.
 *
 * This exists as a real backend endpoint rather than staying mock data for
 * one reason: VITE_USE_MOCK_API is a single global flag (see
 * D:\projects\tokenmeme2\src\api\client.js) — flipping it sends ALL SIX paths
 * to HTTP, not just /coin/stats. Serving only the live tile data would 404
 * the identity panel, marquee and gallery.
 *
 * EDIT HERE: this is the editable config the design doc calls for. Socials,
 * copy, and gallery entries can change without a redeploy of the frontend —
 * only this file (and a restart, since it is read once at module load, not
 * per request).
 *
 * -----------------------------------------------------------------------------
 * LAND OF WOLF ($WOLF) — PLACEHOLDER CONTENT, NOT YET FILLED IN
 * -----------------------------------------------------------------------------
 * This is a rebrand of the $BRETT stats backend for Land of Wolf. The real
 * contract address, socials, tagline, blurb and gallery art have not been
 * provided yet, so every one of those fields below is an explicit,
 * unmissable placeholder rather than an invented value or Brett's leftover
 * copy. Search this file for "PLACEHOLDER" and fill each one in before
 * launch — see also TOKEN_ADDRESS in .env.example, which this file's
 * `contract` field must be kept in sync with once it is set.
 */

export const CONTENT_BPM = 90

/** PLACEHOLDER identity block for Land of Wolf. Structure mirrors the
    frontend's identity.js field-for-field; every value below that is
    genuinely token-specific (tagline, blurb, contract, socials) is a marked
    placeholder, not a guess. */
export const coinMeta = {
  ticker: 'WOLF',
  name: 'Land of Wolf',
  // PLACEHOLDER — replace with the real tagline before launch.
  tagline: 'PLACEHOLDER TAGLINE — replace before launch',
  // PLACEHOLDER — replace with the real project blurb before launch.
  blurb: 'PLACEHOLDER BLURB — replace with real Land of Wolf copy before launch.',
  chain: 'Robinhood',
  // PLACEHOLDER — the real $WOLF contract address has not been provided.
  // Do not invent one. Set this (and TOKEN_ADDRESS in .env) together once
  // the token is deployed and verified.
  contract: 'SET_CONTRACT_ADDRESS_BEFORE_LAUNCH',
  // PLACEHOLDER — real launch timestamp not yet known.
  launchedAt: 'SET_LAUNCH_DATE_BEFORE_LAUNCH',
  doors: '00:00',
  socials: [
    // PLACEHOLDER — href "#" renders as a dead link on the frontend by
    // design (see identity.js's own header comment); set the real URL
    // before launch.
    { id: 'x', label: 'X', href: '#', glyph: 'X' },
    { id: 'tg', label: 'Telegram', href: '#', glyph: 'TG' },
  ],
  buyUrl: '#buy',
  chartUrl: '#chart',
}

/** Scrolling marquee copy. Mirrors stats.js's tickerFeed shape — plain
    strings, the frontend upper-cases them. PLACEHOLDER lines: Brett's
    "hood" slogans do not belong to Land of Wolf, and no real marquee copy
    has been provided yet — replace every line below before launch. */
export const tickerFeed = {
  bpm: CONTENT_BPM,
  lines: [
    'PLACEHOLDER MARQUEE LINE — REPLACE BEFORE LAUNCH',
    'LAND OF WOLF MARQUEE COPY GOES HERE',
    'SWAP THESE LINES FOR REAL CONTENT',
  ],
}

export const galleryCategories = [
  { id: 'all', label: 'Everything', glyph: '✦' },
  { id: 'crew', label: 'The Crew', glyph: '☺' },
  { id: 'rig', label: 'The Pack', glyph: '▣' },
  { id: 'relics', label: 'Relics', glyph: '★' },
]

/* Mirrors data.js: the meme wall is served as static config (see the design
   doc's "Out of scope" — making the gallery dynamic is a separate feature).
   PLACEHOLDER image paths: Brett's donor project used real frontend assets
   (b1.png..b4.png); Land of Wolf has no gallery art yet, so these point at
   obviously-placeholder filenames instead of silently reusing Brett's. Swap
   for real Land of Wolf assets (and matching /public/meme/ files in the
   frontend) before launch — keep the same array shape. */
const MEMES = [
  '/meme/placeholder-1.png',
  '/meme/placeholder-2.png',
  '/meme/placeholder-3.png',
  '/meme/placeholder-4.png',
]
const SPAN_CYCLE = ['tall', 'tall', 'tall', 'tall']

export const galleryItems = MEMES.map((image, i) => ({
  id: `meme-${String(i + 1).padStart(3, '0')}`,
  title: '',
  subtitle: '',
  category: 'rig',
  art: null,
  palette: ['#a8e614', '#ec1e79', '#2b86f0'],
  image,
  rarity: '',
  likes: 0,
  span: SPAN_CYCLE[i % SPAN_CYCLE.length],
  caption: '',
}))
