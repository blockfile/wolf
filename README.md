# $WOLF stats backend

Serves the Land of Wolf site for an ERC-20 on **Robinhood Chain** (id 4663):
live market cap, holders and burned %, plus the identity, marquee and
gallery content the frontend also expects.

No frontend code changes are required. `VITE_USE_MOCK_API` is a single
global flag in the frontend — flip it off and point `VITE_API_BASE_URL` at
this server, and all six paths it calls resolve.

This is a rebrand of the `$BRETT` stats backend (donor: `d:\projects\brett`)
for Land of Wolf. Two values have not been provided yet and are deliberately
left as unmissable placeholders rather than invented — see *Two things not
set yet* below.

---

## Two things not set yet

- **`TOKEN_ADDRESS`** — the real `$WOLF` contract has not been provided. It
  is left **unset** in `.env.example`. The backend already handles this
  correctly: `/coin/stats` returns `200` with null figures and
  `placeholder: true` rather than an error — see *Pre-launch behaviour*
  below. Do not fill this in with a guess.
- **The production domain** — not yet provided. Every reference to it in
  this repo (`deploy/nginx.conf`, this README, and the test that pins the
  two together) uses the placeholder `api.landofwolf.example`. **This must
  be replaced before deploying.** `deploy/nginx.conf` explicitly 444s any
  request whose Host header does not match `server_name` — if the
  placeholder ships as-is, the real frontend's requests get silently
  dropped, which reads like a DNS fault, not a one-line config mismatch. See
  the warning banner at the top of `deploy/nginx.conf`.

---

## Quick start

```bash
npm install
cp .env.example .env      # TOKEN_ADDRESS is unset until the real contract exists
npm start                 # http://localhost:8787
```

```bash
npm test                  # node:test, no network
npm run probe             # check each upstream and print what it returned
```

---

## Going live — the whole checklist

**1. In this project's `.env`:**

```ini
TOKEN_ADDRESS=<the real $WOLF contract — not yet known, do not guess>
CORS_ORIGIN=https://landofwolf.example
```

(Replace `landofwolf.example` with the real site domain once it exists —
see *Two things not set yet* above.)

**2. In the frontend's `.env`** (`D:\projects\tokenmeme2\.env`):

```ini
VITE_USE_MOCK_API=false
VITE_API_BASE_URL=https://api.landofwolf.example
```

That's it. No frontend source file is touched — see "Why it doesn't need a
frontend change" below.

**3. On the droplet:**

```bash
git clone https://github.com/blockfile/wolf.git
cd wolf
npm install --omit=dev
cp .env.example .env && $EDITOR .env   # set TOKEN_ADDRESS and CORS_ORIGIN
pm2 start ecosystem.config.cjs
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wolf-api
sudo ln -sf /etc/nginx/sites-available/wolf-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.landofwolf.example --redirect
```

**Before any of this**, replace every `api.landofwolf.example` placeholder
in `deploy/nginx.conf` (and the `certbot -d` flag above) with the real
domain — see the warning banner at the top of that file.

**Until `TOKEN_ADDRESS` is set,** `/coin/stats` returns nulls and the tiles
show dashes. That is deliberate — see *Pre-launch behaviour* below.

---

## Why it doesn't need a frontend change

`VITE_USE_MOCK_API` (`D:\projects\tokenmeme2\src\api\client.js`) is a single
global switch: with mocking off, every one of the six paths the frontend
calls goes over HTTP. Serving only `/coin/stats` would leave the identity
panel, marquee and gallery requesting a server that answers 404 for
everything else — the contract address, socials and every meme image would
vanish.

So this backend answers all six:

| Path | Data |
| --- | --- |
| `GET /coin/stats` | **Live.** Market cap, holders, burned % — see below. |
| `GET /coin/meta` | Static — `src/content.js`'s `coinMeta`. |
| `GET /coin/ticker` | Static — `src/content.js`'s `tickerFeed`. |
| `GET /gallery` | Static, paginated/filtered — `src/content.js`'s `galleryItems`. |
| `GET /gallery/categories` | Static — `src/content.js`'s `galleryCategories`. |
| `GET /gallery/:id` | Static — one item from `galleryItems`, 404 if unknown. |
| `GET /health` | Liveness. |

The five static ones mirror the frontend's own mock fixtures
(`src/api/mock/identity.js`, `stats.js`'s `tickerFeed`, `data.js`) field for
field, so the response shape the frontend already renders against does not
change — only where the data comes from does. They live in one editable file
(`src/content.js`), so socials, copy and gallery entries can change without a
frontend redeploy — just edit the file and restart.

**`src/content.js` still carries several `PLACEHOLDER` values** — tagline,
blurb, contract, socials, gallery images and marquee lines — because none of
that copy has been provided for Land of Wolf. Search the file for
`PLACEHOLDER` and fill each one in before launch.

---

## `GET /coin/stats`

**Pre-launch (today — `TOKEN_ADDRESS` unset):**

```json
{
  "updatedAt": "2026-08-11T12:00:00.000Z",
  "bpm": 90,
  "items": [
    { "id": "mcap", "label": "Marketcap", "value": null, "format": "usdCompact", "delta": 0, "accent": "gold" },
    { "id": "holders", "label": "Total Holders", "value": null, "format": "compact", "delta": 0, "accent": "bubblegum" },
    { "id": "burned", "label": "Burned", "value": null, "format": "percent", "delta": 0, "accent": "flare" }
  ]
}
```

**Once `TOKEN_ADDRESS` is set and the token is live**, the same three tiles
carry real numbers instead of nulls — shape only, illustrative:

```json
{
  "updatedAt": "2026-08-11T12:00:00.000Z",
  "bpm": 90,
  "items": [
    { "id": "mcap", "label": "Marketcap", "value": 12345, "format": "usdCompact", "delta": 12, "accent": "gold" },
    { "id": "holders", "label": "Total Holders", "value": 42, "format": "compact", "delta": 0, "accent": "bubblegum" },
    { "id": "burned", "label": "Burned", "value": 0, "format": "percent", "delta": 0, "accent": "flare" }
  ]
}
```

Matches `D:\projects\tokenmeme2\src\api\mock\stats.js` key-for-key. `id`,
`format` and `accent` are the frontend's own vocabulary — it uses them to
pick a formatter (`src/lib/format.js`) and a tile colour. `value` is always a
raw number (or `null`); the frontend formats it, never this backend.

### Where the three numbers come from

| Figure | Source | Why that one |
| --- | --- | --- |
| **mcap** | Dexscreener `marketCap`, falling back to `priceUsd x totalSupply` | Dexscreener publishes a market cap directly for an indexed pair — more authoritative than recomputing it, and the fallback only matters for the rare case where a pair is priced but not yet market-capped. |
| **holders** | Blockscout `/tokens/{addr}/counters` | A plain RPC node cannot answer "how many addresses hold this token" — that means replaying every Transfer since deployment, the indexing the explorer already does. |
| **burned** | `balanceOf(0x…dEaD) + balanceOf(0x0)`, as a % of `totalSupply` | A plain ERC-20 with no `burn()` and no burn accounting has sending to `0x…dEaD` as the only way tokens leave circulation, and `totalSupply()` never reflects it. |

No on-chain figures have been verified for `$WOLF` yet — `TOKEN_ADDRESS` is
unset (see *Two things not set yet*). Once it is set, `npm run probe` walks
the same path with failures made loud, so you can check each upstream
independently before trusting the live site.

### The 24h deltas

- **mcap** — Dexscreener's own `priceChange.h24`. Real and free.
- **holders / burned** — nothing upstream reports history for either. This
  backend writes **one snapshot per day** to a flat JSON file
  (`src/snapshot.js`, path set by `SNAPSHOT_PATH`) and diffs the current
  figures against it. The first day this backend runs — or any day after the
  snapshot file is deleted or corrupted — there is nothing to diff against,
  so both deltas read `0` (which the UI renders as "flat"). From the second
  day on they are real. A missing, empty or corrupt snapshot file degrades to
  `0`; it never fails the request. Writing the snapshot is fire-and-forget
  from the request's point of view — a full disk or a permissions error
  cannot delay or fail `/coin/stats`.

---

## Failure behaviour

`/coin/stats` degrades **per tile**, not as a whole. Holders, the on-chain
read (supply + burned) and Dexscreener are fetched **concurrently** — a
`Promise.allSettled`, not three sequential awaits — so one failing does not
delay or block the others. The failing tile's value is `null` and the reason
lands in `warnings`. **Losing holders costs nothing else**: market cap comes
from Dexscreener plus the on-chain supply read, neither of which touches
Blockscout's holder count.

**Pre-launch** (`TOKEN_ADDRESS` unset) — `200` with null figures and
`placeholder: true`, not an error. The frontend renders null as an em dash;
an error would trip the RETRY panel and tell visitors the site is broken
when it is merely early.

**Total outage** — every upstream down at once still returns `200`, with all
three tiles `null` and a warning recorded per tile. It does **not** become a
`503`, and `STALE_MAX_MS` does not change that: `collect()` absorbs every
upstream failure in its `Promise.allSettled` group and therefore never
rejects, which is precisely what the cache's stale-then-fail path keys on.

Degrading per tile is the deliberate choice — losing Blockscout must not cost
the market cap — but it has one operational consequence worth knowing before
you wire up alerting:

> **A 5xx-rate monitor will never catch a sustained upstream outage here.**
> Alert on the body instead: a tile whose `value` is `null`, or a non-empty
> `warnings` array. Verified by taking all three upstreams down at once —
> the endpoint kept answering `200` indefinitely.

**Cold start** — a request landing before the first `collect()` finishes
waits at most `STATS_WAIT_MS` (default 5s) before getting an honest `503`
rather than hanging — see *The one wait budget* below.

**Load** — responses are cached for `CACHE_TTL_MS` (default 30s) and
concurrent misses share one upstream fetch, so a launch-day crowd produces
one request per cycle rather than thousands.

---

## The one wait budget — and the outage it exists to prevent

This backend is ported (via the `$BRETT` stats backend, `d:\projects\brett`)
from the PONSY stats backend (`d:\projects\ponsy`), which had the **same
production outage twice**: a wait budget on some route that quietly outlived
nginx's `proxy_read_timeout`, so nginx returned its own 504 over a request
that was about to succeed. Both times the two numbers that needed to agree
lived in files nobody reads together — an env var in `src/config.js` and a
directive in `deploy/nginx.conf`.

This backend has exactly **one** wait budget, `STATS_WAIT_MS` (default 5s,
bounding `GET /coin/stats`), because there is no `/quote` route here to add a
second one — the whole class of bug where two wait budgets compose
sequentially past the ceiling cannot occur, because there is only one route
that waits on anything at all. `src/config.js`'s `waitBudgetWarning()` checks
that lone budget against `NGINX_PROXY_READ_TIMEOUT_MS` (mirroring
`deploy/nginx.conf`'s `proxy_read_timeout 15s`) and warns at startup if it
doesn't hold; `test/config.test.js` pins the two files together by reading
the real `deploy/nginx.conf`, so they cannot drift apart silently the way the
donor project's did.

The other structural half of the fix: every upstream call `/coin/stats`
makes — Blockscout holders, the RPC batch, Dexscreener — runs in **one**
`Promise.allSettled` group in `src/stats.js`, never a sequential fallback
after it. That is the property that makes a single `STATS_WAIT_MS` at all
sufficient: the worst case is one `UPSTREAM_TIMEOUT_MS`, not a multiple of
it.

---

## Design notes

**No `ethers` or `viem`.** Every RPC call needed (`totalSupply`, `decimals`,
`balanceOf`) is either zero-argument or takes one address, so calldata is a
constant 4-byte selector (plus one padded address) and decoding is
fixed-width hex slicing — about 30 lines of BigInt (`src/chain/abi.js`,
`src/chain/decimals.js`). The only runtime dependency is Express.

**BigInt for supply and balances.** A raw 1e27-scale supply is already past
Number's exact-integer range; both stay BigInt until a single final division
so the low digits are not silently lost.

**A flat file for the daily snapshot, not a database.** One write a day, a
few dozen bytes, one fewer service to run on the droplet.

**What was dropped from the donor.** Everything swap-related — `quote.js`,
`tokens.js`, `chain/solana.js`, `sources/relay.js`, `chain/uniswapV3.js`, the
`/quote` and `/quote/status` routes, `POOL_ADDRESS`/`WETH_ADDRESS` and
on-chain pool pricing, `ETH_USD`/`fetchNativeUsd`. This backend serves three
numbers plus static content, never a swap — market cap comes from
Dexscreener alone.

---

## Layout

```
src/
  index.js              entry point — wiring and startup
  config.js              env parsing + validation, fail-fast, the wait-budget guard
  server.js               Express, CORS, all six routes + /health
  stats.js                orchestration: concurrent fetch, per-tile degradation
  snapshot.js              once-a-day holders/burned snapshot + delta math
  content.js               static config for meta/ticker/gallery — carries PLACEHOLDER values, see above
  cache.js                 TTL, request coalescing, stale-on-failure
  refresher.js             background timer that keeps the cache warm
  http.js                  shared GET with timeout
  chain/
    rpc.js                 batched JSON-RPC over fetch
    abi.js                 selectors + returndata decoding
    decimals.js            raw uint256 -> whole-token Number
  sources/
    blockscout.js           holders
    dexscreener.js           price, market cap, 24h change
scripts/probe.js         per-upstream diagnostic
test/                    node:test, synthetic fixtures (no real $WOLF data exists yet)
deploy/nginx.conf        reverse proxy config, wait-budget-consistent — placeholder domain, see warning banner
ecosystem.config.cjs     PM2 process file
```

## Configuration

Every variable is documented in `.env.example`. `TOKEN_ADDRESS` (currently
unset — see *Two things not set yet*) and `CORS_ORIGIN` are the only ones
worth touching before going live.
