import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { SqliteStorageService } from './storage'

const now = '2026-10-25T00:00:00.000Z'
const location = (nativeSessionId: string, date = now) => ({
  sourceId: 'pi',
  installationId: 'local-pi',
  nativeSessionId,
  locationKind: 'native' as const,
  filePath: resolve('/tmp', `${nativeSessionId}.jsonl`),
  fileIdentity: '1:1',
  fileSize: 256,
  fileMtimeMs: 1_790_000_000_000,
  lastActivityAt: date,
  updatedAt: now,
})

test('native session catalog remains metadata-only, stable and independently pageable', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const catalog = storage.nativeSessionCatalog
    const old = location('a','2026-10-20T00:00:00Z')
    const middle = location('b','2026-10-22T00:00:00Z')
    const newest = location('c','2026-10-24T00:00:00Z')
    await catalog.upsert(old)
    await catalog.upsert(middle)
    await catalog.upsert(newest)
    await catalog.upsert({ ...middle, fileSize: 300, title: 'Generated session title' })

    const first = await catalog.query({ limit: 2 })
    assert.deepEqual(first.items.map(x => x.nativeSessionId), ['c','b'])
    assert.equal(first.hasMore,true)
    assert.equal(first.items[1]?.fileSize,300)
    const last = first.items[1]!
    const next = await catalog.query({ limit: 2,
      before: { lastActivityAt: last.lastActivityAt,sourceId: last.sourceId,
        installationId: last.installationId,nativeSessionId: last.nativeSessionId,
        locationKind: last.locationKind } })
    assert.deepEqual(next.items.map(x => x.nativeSessionId), ['a'])
    assert.equal(next.hasMore,false)
    assert.equal((await catalog.get({sourceId:'pi',installationId:'local-pi',nativeSessionId:'b'}))?.title,
      'Generated session title')

    await catalog.upsert({ ...middle, locationKind: 'archive', filePath: resolve('/tmp','vault','b.jsonl') })
    assert.equal((await catalog.query({ locationKind: 'archive' })).items.length,1)
    assert.equal((await catalog.get({sourceId:'pi',installationId:'local-pi',nativeSessionId:'b'}))?.locationKind,'native')
    assert.equal((await catalog.get({sourceId:'pi',installationId:'local-pi',nativeSessionId:'b',locationKind:'archive'}))?.locationKind,'archive')

    const columns = storage.db.prepare('PRAGMA table_info(native_session_catalog)').all() as Array<{name:string}>
    assert.equal(columns.some(x=>x.name==='payload' || x.name==='payload_json' || x.name==='observation_id'),false)
    const rows = storage.db.prepare('SELECT COUNT(*) AS count FROM native_session_catalog').get() as {count:number}
    assert.equal(rows.count,4)
    await assert.rejects(catalog.upsert({ ...middle, filePath: '../relative.jsonl' }))
    await assert.rejects(catalog.query({limit:5000}))
  } finally {
    storage.close()
  }
})
