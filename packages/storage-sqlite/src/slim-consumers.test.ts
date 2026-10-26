import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { NATIVE_SESSION_METRIC_PROJECTION_VERSION } from '@agent-lens/core'
import { SqliteExecutor } from './executor'
import { initializeSlimSchema, assertSlimSchema } from './slim-schema'
import { SqliteNativeSessionCatalog } from './native-session-catalog'
import { SqliteNativeSessionMetrics } from './native-session-metrics'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteAssetInventoryReader } from './asset-inventory'
import { upsertAssetCurrentState } from './asset-current-state'

const at = '2026-10-26T00:00:00.000Z'
const identity = {sourceId:'pi', installationId:'installation', nativeSessionId:'session'}

test('slim Catalog, numerical overview, profile and current assets use no Legacy tables', async () => {
  const db = new Database(':memory:')
  try {
    await initializeSlimSchema(db)
    assertSlimSchema(db)
    const executor = new SqliteExecutor(db)
    db.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
      VALUES ('host','local','win32','x64',?,?)`).run(at,at)
    db.prepare(`INSERT INTO agent_products(id,name) VALUES ('pi','Pi')`).run()
    db.prepare(`INSERT INTO agent_installations(
      id,host_id,product_id,first_seen_at,last_seen_at
    ) VALUES ('installation','host','pi',?,?)`).run(at,at)
    const catalog = new SqliteNativeSessionCatalog(executor)
    const location = {
      ...identity, locationKind: 'native' as const,
      filePath: resolve('sessions/session.jsonl'), fileIdentity:'1:1',
      fileSize:120,fileMtimeMs:12,lastActivityAt:at,updatedAt:at,
    }
    await catalog.upsert(location)
    const projected = await catalog.query({ onlyWithoutLegacyReview:true, limit:10 })
    assert.equal(projected.items.length,1)
    assert.equal(projected.items[0]?.nativeSessionId,'session')
    assert.equal(await catalog.isNativeMetricsEligible(identity),true)
    assert.equal(await catalog.isNativeMetricsEligible({
      ...identity,nativeSessionId:'missing',
    }),false)
    const reviewId = 'native:' +
      (await import('node:crypto')).createHash('sha256')
        .update(JSON.stringify(['pi','installation','session']))
        .digest('hex').slice(0,32)
    assert.equal((await catalog.getByReviewSessionId(reviewId))?.nativeSessionId,'session')
    await assert.rejects(catalog.getSessionWriteMode(identity), /not supported/)
    await assert.rejects(catalog.hasNativeOnlyWriteClaim(identity), /not supported/)
    await assert.rejects(catalog.claimLegacyWrite(identity), /forbidden/)
    await assert.rejects(catalog.claimNativeOnlyWrite({
      ...identity,filePath:location.filePath,fileIdentity:location.fileIdentity,
    }), /not supported/)

    const profiles = new SqliteRuntimeProfileRepository(executor)
    const runtime = await profiles.resolve({
      installationId:'installation', nativeProfileId:'default',
    })
    await profiles.attachSession('pi','installation','session',runtime.id)
    const context = db.prepare(`SELECT runtime_profile_id
      FROM native_session_context WHERE native_session_id='session'`)
      .get() as {runtime_profile_id:string}
    assert.equal(context.runtime_profile_id,runtime.id)

    const metrics = new SqliteNativeSessionMetrics(executor)
    assert.equal(await metrics.replace({
      ...identity,
      fileIdentity:location.fileIdentity,fileSize:location.fileSize,
      fileMtimeMs:location.fileMtimeMs,parserVersion:'pi-v1',
      projectionVersion:NATIVE_SESSION_METRIC_PROJECTION_VERSION,
      coverage:'complete',interactionCount:2,toolCallCount:1,
      toolResultCount:1,toolErrorCount:0,errorCount:0,
      inputTokens:10,outputTokens:5,computedAt:at,
      tools:[{nativeToolName:'read',callCount:1,resultCount:1,
        errorCount:0,totalDurationMs:42}],
    }),true)
    const summary = await metrics.overview({
      sourceId:'pi',parserVersion:'pi-v1',coverageCertified:true,
    })
    assert.equal(summary.eligibleSessions,1)
    assert.equal(summary.readySessions,1)
    assert.equal(summary.totals.toolCallCount,1)
    assert.equal(summary.tools[0]?.nativeToolName,'read')
    assert.deepEqual(await metrics.findRebuildCandidates({
      sourceId:'pi',parserVersion:'pi-v1',
    },4),[])
    const stale = await metrics.findRebuildCandidates({
      sourceId:'pi',parserVersion:'pi-v2',
    },4)
    assert.equal(stale.length,1)
    assert.equal(stale[0]?.nativeSessionId,'session')

    db.prepare(`INSERT INTO asset_definitions(id,type,canonical_name)
      VALUES ('asset','skill','test-skill')`).run()
    db.prepare(`INSERT INTO asset_bindings(id,asset_id,installation_id)
      VALUES ('binding','asset','installation')`).run()
    upsertAssetCurrentState(db, {
      id:'state',assetBindingId:'binding',state:'enabled',
      value:true,observedAt:at,evidenceRefs:[],
    })
    const inventory = new SqliteAssetInventoryReader(executor)
    const items = await inventory.listByInstallation('installation')
    assert.equal(items.length,1)
    assert.equal(items[0]?.states[0]?.value,true)
    assert.deepEqual(items[0]?.states[0]?.evidenceRefs,[])
    await inventory.rebuildCurrentState()
    assert.deepEqual(db.pragma('foreign_key_check'),[])
  } finally { db.close() }
})
