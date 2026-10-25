import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { nativeReviewSessionId } from '@agent-lens/core'
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

    // File walkers can observe older events after newer ones during replay.
    // Keep the newest real session activity even when upserts arrive late.
    await catalog.upsert({ ...middle, lastActivityAt: '2026-10-21T00:00:00Z' })
    assert.equal((await catalog.get({sourceId:'pi',installationId:'local-pi',nativeSessionId:'b'}))?.lastActivityAt,
      '2026-10-22T00:00:00Z')

    const byNativeId = await catalog.getByReviewSessionId(
      nativeReviewSessionId('pi','local-pi','b'),
    )
    assert.equal(byNativeId?.nativeSessionId,'b')
    assert.equal(byNativeId?.title,'Generated session title')
    assert.equal(await catalog.getByReviewSessionId('invalid'),null)
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

    // Match old sessions by Source/Installation/native ID only, not by
    // identical names or approximate activity timestamps. Only an actual
    // persisted logical session with observations suppresses the native row.
    storage.db.prepare(`INSERT INTO hosts
      (id,name,platform,arch,created_at,last_seen_at) VALUES (?,?,?,?,?,?)`)
      .run('host','local','linux','x64',now,now)
    storage.db.prepare(`INSERT INTO agent_products(id,name) VALUES (?,?)`).run('pi','Pi')
    storage.db.prepare(`INSERT INTO agent_installations
      (id,host_id,product_id,first_seen_at,last_seen_at) VALUES (?,?,?,?,?)`)
      .run('local-pi','host','pi',now,now)
    for (const id of ['b','c']) {
      storage.db.prepare('INSERT INTO logical_sessions(id,installation_id) VALUES (?,?)')
        .run('logical-'+id,'local-pi')
      storage.db.prepare(`INSERT INTO source_sessions
        (id,source_id,installation_id,native_session_id,logical_session_id)
        VALUES (?,?,?,?,?)`).run('source-'+id,'pi','local-pi',id,'logical-'+id)
    }
    // A SourceSession relationship alone does NOT mean Review has content.
    const partial = await catalog.query({onlyWithoutLegacyReview:true,limit:2,locationKind:'native'})
    assert.deepEqual(partial.items.map(x=>x.nativeSessionId),['c','b'])
    for (const id of ['b','c']) {
      storage.db.prepare(`INSERT INTO observations
        (id,host_id,installation_id,logical_session_id,source_session_id,kind,captured_at,payload_json)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run('observation-'+id,'host','local-pi','logical-'+id,'source-'+id,
          'message.user',now,'{"text":"never included in catalog output"}')
    }
    // SQL excludes c and b *before* its LIMIT, so a is still reachable.
    const unmatched = await catalog.query({onlyWithoutLegacyReview:true,limit:1,locationKind:'native'})
    assert.deepEqual(unmatched.items.map(x=>x.nativeSessionId),['a'])
    assert.equal(unmatched.hasMore,false)
    // Unfiltered view still exposes all original catalog entries.
    const allNative = await catalog.query({locationKind:'native',limit:3})
    assert.deepEqual(allNative.items.map(x=>x.nativeSessionId),['c','b','a'])
    assert.equal(JSON.stringify(unmatched).includes('never included'),false)

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
