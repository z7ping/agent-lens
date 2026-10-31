import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const inProcess = readFileSync(new URL('./in-process-host.ts', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const first = worker.indexOf(start)
  const last = worker.indexOf(end, first)
  assert.ok(first >= 0 && last > first, 'Pi Worker index functions must remain available')
  return worker.slice(first, last)
}

test('Pi Live count-only queries never calculate full-round summaries', () => {
  const state: { leaf: string; entries: Array<{
    id: string; type: string; message: { role: string; content?: unknown }
  }> } = {
    leaf: 'main',
    entries: [
      { id: 'u1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { id: 'a1', type: 'message', message: { role: 'assistant' } },
      { id: 'u2', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
      { id: 'a2', type: 'message', message: { role: 'assistant' } },
    ],
  }
  const scans: Array<{ cursor: string; end: number }> = []
  const context = {
    roundIndexCache: undefined as unknown,
    session: { sessionManager: { getEntries: () => state.entries, getLeafId: () => state.leaf } },
    record: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? value : {},
    entryId: (value: unknown) => {
      const entry = value as { id?: unknown }
      return typeof entry?.id === 'string' ? entry.id : undefined
    },
    roundSummary: (_all: unknown[], row: { cursor: string }, nextEntryIndex: number) => {
      scans.push({ cursor: row.cursor, end: nextEntryIndex })
      return { process: { itemCount: nextEntryIndex } }
    },
    LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT: 120,
  }
  const api = runInNewContext(
    section('function invalidateActiveRoundSummary(', '\nfunction snapshotRoundPage(')
      + section('function historyIndex(queryValue)', '\nfunction sessionTreePreview(')
      + '\n({ historyIndex, invalidateActiveRoundSummary })',
    context,
  ) as { invalidateActiveRoundSummary(): void; historyIndex(query: { limit?: number; cursor?: string; fromOrdinal?: number }): {
    total: number; items: Array<{ cursor: string; ordinal: number; summary: unknown }>
  } }
  assert.equal(api.historyIndex({ limit: 0 }).total, 2)
  assert.equal(scans.length, 0, 'count-only must not read per-turn details')
  const first = api.historyIndex({ fromOrdinal: 2, limit: 1 })
  assert.equal(first.items[0]?.cursor, 'u2')
  assert.equal((first.items[0] as { nativeEventId?: string })?.nativeEventId,'u2')
  assert.deepEqual(scans.map(item => item.cursor), ['u2'])
  api.historyIndex({ cursor: 'u2' })
  assert.equal(scans.length, 1, 'requested summary is cached')

  const oldMap = (context.roundIndexCache as { entryPositions: Map<string, number> }).entryPositions
  state.entries.push({ id: 'a3', type: 'message', message: { role: 'assistant' } })
  assert.equal(api.historyIndex({ limit: 0 }).total, 2)
  assert.equal((context.roundIndexCache as { entryPositions: Map<string, number> }).entryPositions, oldMap,
    'append must preserve private position index identity')
  assert.equal(scans.length, 1)
  api.historyIndex({ fromOrdinal: 2, limit: 1 })
  assert.equal(scans.length, 2, 'only the active tail round needs a fresh summary')
  assert.equal(scans[1]?.end, 5)

  state.entries.push({ id: 'u3', type: 'message', message: { role: 'user', content: 'third' } })
  api.historyIndex({ fromOrdinal: 3, limit: 1 })
  assert.equal(scans.at(-1)?.cursor, 'u3')
  api.historyIndex({ fromOrdinal: 1, limit: 1 })
  assert.equal(scans.at(-1)?.cursor, 'u1')
  assert.equal(api.historyIndex({ limit: 0 }).total, 3)

  // The SDK can revise a message with the same entry id/count. Only the
  // active tail summary must be refreshed when its native event arrives.
  const beforeNativeEvent = scans.length
  state.entries.at(-1)!.message.content = 'updated in-place'
  api.invalidateActiveRoundSummary()
  api.historyIndex({ fromOrdinal: 3, limit: 1 })
  assert.equal(scans.length, beforeNativeEvent + 1)
  api.historyIndex({ fromOrdinal: 1, limit: 1 })
  assert.equal(scans.length, beforeNativeEvent + 1, 'completed prefix remains cached')

  // Corrupt/replayed native entries can reuse an ID. Cursor-based seeking
  // must fail closed rather than selecting whichever duplicate came last.
  state.entries.push({ id: 'u2', type: 'message', message: { role: 'user', content: 'duplicate' } })
  assert.equal(api.historyIndex({ cursor: 'u2' }).items.length, 0)
  assert.equal((context.roundIndexCache as {entryPositions: Map<string,number>})
    .entryPositions.get('u2'), -1)
  assert.equal(api.historyIndex({ limit: 0 }).total, 4,
    'round count remains based on physical native user entries')
  state.leaf = 'other-branch'
  state.entries = [
    { id: 'branch-u1', type: 'message', message: { role: 'user', content: 'branched' } },
  ]
  const replacement = api.historyIndex({ fromOrdinal: 1, limit: 1 })
  assert.equal(replacement.total, 1)
  assert.equal((replacement.items[0] as { nativeEventId?: string })?.nativeEventId,'branch-u1')
  assert.equal(replacement.items[0]?.cursor, 'branch-u1',
    'branch switch must not leak the former turn index')
  assert.notEqual((context.roundIndexCache as { entryPositions: Map<string, number> }).entryPositions, oldMap)
})

test('Pi in-process fallback also avoids cloning large index maps on append', () => {
  assert.match(inProcess, /const rows = appendOnly \? cached\.rows : \[\]/)
  assert.match(inProcess, /const entryPositions = appendOnly \? cached\.entryPositions/)
  assert.match(inProcess, /const roundByCursor = appendOnly \? cached\.roundByCursor/)
  assert.doesNotMatch(inProcess, /new Map\(cached\.entryPositions\)/)
  assert.doesNotMatch(inProcess, /new Map\(cached\.roundByCursor\)/)
  assert.match(inProcess, /entryPositions\.has\(entry\.id\)/)
  assert.match(inProcess, /entryPositions\.get\(row\.cursor\) === -1\) roundByCursor\.delete/)
  assert.match(inProcess, /if \(position !== -1\) return -1/,
    'initial snapshots must reject duplicate cursors even without a built index')
  assert.match(worker, /if \(position !== -1\) return -1/,
    'Worker initial snapshot must reject duplicate native cursors')
})

test('Pi snapshot round metadata seeks directly to the visible index range', () => {
  const source = section('function snapshotRoundPage(', '\nfunction beginSnapshotTransfer(')
  assert.match(source, /while \(left < right\)/)
  assert.match(source, /rows\[middle\]\.entryIndex < start/)
  assert.doesNotMatch(source, /for \(const row of rows\)/)
  assert.match(inProcess, /while \(left < right\)/)
  assert.doesNotMatch(inProcess, /for \(const row of rows\)/)
})

test('Pi SDK event invalidates the active summary without rebuilding the position index', () => {
  assert.match(worker, /session\.subscribe\(event => \{\s*invalidateActiveRoundSummary\(\)/)
  const invalidator = section('function invalidateActiveRoundSummary(', '\nfunction roundIndex(')
  assert.match(invalidator, /roundIndexCache\?\.rows\?\.at\(-1\)/)
  assert.match(invalidator, /delete tail\.summary/)
  assert.doesNotMatch(invalidator, /roundIndexCache = undefined/)
})
