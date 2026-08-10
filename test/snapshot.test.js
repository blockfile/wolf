import test from 'node:test'
import assert from 'node:assert/strict'

import { createSnapshotStore, relativeDeltaPct, pointDelta } from '../src/snapshot.js'

/** In-memory fake of the node:fs/promises surface createSnapshotStore needs. */
function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))
  return {
    files,
    async readFile(path) {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`)
        err.code = 'ENOENT'
        throw err
      }
      return files.get(path)
    },
    async writeFile(path, data) {
      files.set(path, data)
    },
    async mkdir() {},
  }
}

test('relativeDeltaPct is 0 when there is no previous value (no snapshot yet)', () => {
  assert.equal(relativeDeltaPct(118, null), 0)
  assert.equal(relativeDeltaPct(118, undefined), 0)
})

test('relativeDeltaPct is 0 when the current value is missing', () => {
  assert.equal(relativeDeltaPct(null, 100), 0)
})

test('relativeDeltaPct computes a real percentage change against a real previous value', () => {
  assert.equal(relativeDeltaPct(110, 100), 10)
  assert.equal(relativeDeltaPct(90, 100), -10)
})

test('relativeDeltaPct guards a zero previous value: no Infinity or NaN', () => {
  const result = relativeDeltaPct(50, 0)
  assert.equal(result, 0)
  assert.ok(!Number.isNaN(result))
  assert.notEqual(result, Infinity)
})

test('pointDelta is 0 when either side is missing', () => {
  assert.equal(pointDelta(4.2, null), 0)
  assert.equal(pointDelta(null, 4.2), 0)
})

test('pointDelta is the raw difference in points, not a ratio', () => {
  assert.ok(Math.abs(pointDelta(4.2, 3.4) - 0.8) < 1e-9)
  assert.equal(pointDelta(0, 0), 0)
})

test('read() returns null when the snapshot file does not exist', async () => {
  const store = createSnapshotStore({ path: 'data/snap.json', fs: fakeFs() })
  assert.equal(await store.read(), null)
})

test('read() returns null for an empty file rather than throwing', async () => {
  const store = createSnapshotStore({
    path: 'data/snap.json',
    fs: fakeFs({ 'data/snap.json': '' }),
  })
  assert.equal(await store.read(), null)
})

test('read() returns null for corrupt JSON rather than throwing', async () => {
  const store = createSnapshotStore({
    path: 'data/snap.json',
    fs: fakeFs({ 'data/snap.json': '{not valid json' }),
  })
  assert.equal(await store.read(), null)
})

test('read() returns null for a valid-JSON-but-wrong-shape file (an array, a bare number)', async () => {
  const arrayStore = createSnapshotStore({
    path: 'data/snap.json',
    fs: fakeFs({ 'data/snap.json': '[1,2,3]' }),
  })
  assert.equal(await arrayStore.read(), null)

  const numberStore = createSnapshotStore({
    path: 'data/snap.json',
    fs: fakeFs({ 'data/snap.json': '42' }),
  })
  assert.equal(await numberStore.read(), null)
})

test('read() returns the parsed snapshot when the file is valid', async () => {
  const store = createSnapshotStore({
    path: 'data/snap.json',
    fs: fakeFs({ 'data/snap.json': JSON.stringify({ date: '2026-08-09', holders: 100, burnedPct: 0 }) }),
  })
  assert.deepEqual(await store.read(), { date: '2026-08-09', holders: 100, burnedPct: 0 })
})

test('write() persists today’s figures under today’s date key', async () => {
  const fs = fakeFs()
  const store = createSnapshotStore({
    path: 'data/snap.json',
    now: () => new Date('2026-08-10T12:00:00.000Z'),
    fs,
  })

  await store.write({ holders: 118, burnedPct: 0 })

  const saved = JSON.parse(fs.files.get('data/snap.json'))
  assert.deepEqual(saved, { date: '2026-08-10', holders: 118, burnedPct: 0 })
})

test('todayKey() is a UTC date, not affected by time-of-day', () => {
  const store = createSnapshotStore({ now: () => new Date('2026-08-10T23:59:59.999Z'), path: 'x', fs: fakeFs() })
  assert.equal(store.todayKey(), '2026-08-10')
})

/* The whole point of the design: a full disk / permissions error must not
   fail the caller. */
test('write() swallows a filesystem error rather than throwing', async () => {
  const store = createSnapshotStore({
    path: 'data/snap.json',
    fs: {
      async readFile() { throw new Error('ENOENT') },
      async mkdir() { throw new Error('EACCES: permission denied') },
      async writeFile() { throw new Error('should not reach here') },
    },
    logger: { warn: () => {} },
  })

  await assert.doesNotReject(() => store.write({ holders: 1, burnedPct: 1 }))
})

test('write() logs a warning on failure so the operator can see it, without throwing', async () => {
  const warnings = []
  const store = createSnapshotStore({
    path: 'data/snap.json',
    fs: {
      async mkdir() {},
      async writeFile() { throw new Error('ENOSPC: no space left on device') },
    },
    logger: { warn: (msg) => warnings.push(msg) },
  })

  await store.write({ holders: 1, burnedPct: 1 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ENOSPC/)
})
