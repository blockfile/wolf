/**
 * DAILY SNAPSHOT
 * -----------------------------------------------------------------------------
 * Gives holders and burned% a 24h delta despite no upstream ever reporting
 * one for either figure (market cap's delta is different — Dexscreener
 * publishes priceChange.h24 directly, see stats.js).
 *
 * The whole mechanism is: write today's holders/burnedPct to a flat JSON file
 * once, the first time collect() runs on a new UTC day, and diff the CURRENT
 * figures against whatever is sitting in that file. That file is always
 * yesterday-or-earlier's value for the entire span of "today", because it
 * only gets overwritten once the day actually rolls over — which is exactly
 * what makes the diff a same-time-yesterday-ish comparison rather than a
 * comparison against five minutes ago.
 *
 * Deliberately a flat file, not a database: one write a day, a few dozen
 * bytes, and one fewer service to run on the droplet.
 *
 * Two things this file is careful about, both required by the design doc:
 *
 *   read failure   a missing, empty, or corrupt snapshot must degrade to "no
 *                  previous value" (null), never throw — the FIRST day this
 *                  backend runs, or after the file is deleted/corrupted by an
 *                  operator, there genuinely is no previous day to diff
 *                  against, and that is not a fetch failure to report as one.
 *
 *   write failure  a full disk or a permissions error must not fail the
 *                  request that triggered the write. The write is fired
 *                  without being awaited by the caller for exactly this
 *                  reason — see write()'s own comment.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @param {object}   opts
 * @param {string}   opts.path      where the snapshot JSON lives
 * @param {Function} [opts.now]     injectable clock for tests
 * @param {object}   [opts.fs]      injectable fs.promises-shaped module for tests
 * @param {object}   [opts.logger]
 */
export function createSnapshotStore({
  path,
  now = () => new Date(),
  fs = { readFile, writeFile, mkdir },
  logger = console,
}) {
  /** Today's date key, UTC so a server's local timezone cannot shift it. */
  function todayKey() {
    return now().toISOString().slice(0, 10)
  }

  /**
   * Reads the stored snapshot. Never throws: a missing file (ENOENT), an
   * empty file, or content that fails JSON.parse all degrade to null exactly
   * alike, because from the caller's point of view they mean the same thing
   * — "there is nothing usable to diff against today."
   */
  async function read() {
    let text
    try {
      text = await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
    if (!text || !text.trim()) return null
    try {
      const parsed = JSON.parse(text)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Writes today's figures. Not awaited by collect() (see stats.js) — a slow
   * or hanging disk must not add latency to a request, and a failing one
   * must not fail it at all. Errors are swallowed here, after being logged,
   * for the same reason: the caller has already moved on.
   */
  async function write({ holders, burnedPct }) {
    try {
      await fs.mkdir(dirname(path), { recursive: true })
      const body = JSON.stringify({ date: todayKey(), holders, burnedPct })
      await fs.writeFile(path, body, 'utf8')
    } catch (err) {
      logger.warn?.(`[snapshot] write failed: ${err.message}`)
    }
  }

  return { read, write, todayKey }
}

/**
 * Relative percentage change, the same unit formatDelta() on the frontend
 * expects for a non-percentage tile (holders: "+9.1%" means "9.1% more
 * holders than yesterday", not "9.1 more holders").
 *
 * Null-safe by construction: a missing current value, a missing previous
 * value, or a previous value of exactly zero (nothing to be a percentage OF)
 * all resolve to 0 — "flat" on the frontend — rather than null, NaN, or
 * Infinity. Zero is honest here: a first day with no snapshot yet is
 * genuinely undetermined, and the design doc calls for 0 in that case.
 */
export function relativeDeltaPct(current, previous) {
  if (current == null || previous == null || previous === 0) return 0
  return ((current - previous) / previous) * 100
}

/**
 * Absolute percentage-point change, the unit burned's own delta needs: its
 * `value` is already a percent (see stats.js/server.js), so its 24h change is
 * "burnedPct today minus burnedPct yesterday" in points, not a percentage of
 * a percentage.
 */
export function pointDelta(current, previous) {
  if (current == null || previous == null) return 0
  return current - previous
}
