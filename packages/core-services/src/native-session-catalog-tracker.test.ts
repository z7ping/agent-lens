import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  NativeSessionCatalogEntry,
  NativeSessionCatalogStore,
  SourceDefinition,
  SourceRecord,
} from '@agent-lens/core'
import { NativeSessionCatalogTracker } from './native-session-catalog-tracker'

const at = '2026-10-25T00:00:00Z'
const accepted = { authority: 'native-store', canReread: true }
const source = {
  manifest: { sourceId: 'pi' },
  readNativeSessionPage() {},
  rawRecovery: { describe: () => accepted },
} as unknown as SourceDefinition
const record = (path: string): SourceRecord => ({
  id: 'native-record', sourceId: 'pi', installationId: 'pi-installed',
  sourceSessionNativeId: 'pi-original', nativeType: 'history/message',
  capturedAt: at, locator: { kind: 'file', path, offset: 0 },
  fingerprint: 'test', parserVersion: '1',
  payload: { entry: { message: { content: 'DO_NOT_PERSIST' } } },
})

test('incremental tracker writes only metadata once per native file window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-catalog-track-'))
  const path = join(root, 'session.jsonl')
  const stored: NativeSessionCatalogEntry[] = []
  const catalog = { async upsert(entry: NativeSessionCatalogEntry) { stored.push(entry) } } as NativeSessionCatalogStore
  let now = Date.parse(at)
  const tracker = new NativeSessionCatalogTracker(catalog, () => now, 30_000)
  try {
    await writeFile(path, '{"type":"session","id":"pi-original"}\n')
    assert.equal(await tracker.observe(source, record(path)), true)
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.sourceId, 'pi')
    assert.equal(stored[0]?.nativeSessionId, 'pi-original')
    assert.equal(stored[0]?.locationKind, 'native')
    assert.equal(stored[0]?.filePath, path)
    assert.equal(Object.keys(stored[0]!).some(key => key.includes('payload') || key.includes('observation')), false)
    assert.equal(JSON.stringify(stored).includes('DO_NOT_PERSIST'), false)

    await appendFile(path, '{"type":"message","id":"one"}\n')
    assert.equal(await tracker.observe(source, record(path)), false)
    assert.equal(stored.length, 1)
    now += 30_001
    assert.equal(await tracker.observe(source, record(path)), true)
    assert.equal(stored.length, 2)
    assert.ok(stored[1]!.fileSize > stored[0]!.fileSize)

    await rm(path)
    now += 30_001
    assert.equal(await tracker.observe(source, record(path)), false)
    // Missing/inaccessible != confirmed deletion: existing catalog stays intact.
    assert.equal(stored.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tracker rejects non-native records and sources without native reader capability', async () => {
  const stored: NativeSessionCatalogEntry[] = []
  const catalog = { async upsert(entry: NativeSessionCatalogEntry) { stored.push(entry) } } as NativeSessionCatalogStore
  const tracker = new NativeSessionCatalogTracker(catalog)
  const recordAtPath = record('/not-existing/session.jsonl')
  assert.equal(await tracker.observe(source, { ...recordAtPath, locator: { kind: 'runtime-hook', hookEventId: 'h' } }), false)
  assert.equal(await tracker.observe(source, { ...recordAtPath, sourceSessionNativeId: undefined }), false)
  assert.equal(await tracker.observe(source, { ...recordAtPath, sourceId: 'codex' }), false)
  assert.equal(await tracker.observe({ ...source, readNativeSessionPage: undefined }, recordAtPath), false)
  assert.deepEqual(stored, [])
})
