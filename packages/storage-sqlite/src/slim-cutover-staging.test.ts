import { LegacyV38TestDatabase } from './legacy-v38-test-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { stageSlimCutover } from './slim-cutover-staging'
import { assertSlimSchema } from './slim-schema'

test('one-time staging backs up v38 and copies only approved metadata, never transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-slim-stage-'))
  const legacyPath = join(dir, 'legacy.db')
  const backupPath = join(dir, 'legacy.backup.db')
  const stagingPath = join(dir, 'slim.stage.db')
  try {
    const old = new LegacyV38TestDatabase({ path: legacyPath })
    try {
      await old.migrate()
      old.db.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
        VALUES ('host','local','win32','x64','2026-10-26','2026-10-26')`).run()
      old.db.prepare(`INSERT INTO agent_products(id,name) VALUES ('product','Pi')`).run()
      old.db.prepare(`INSERT INTO agent_installations(
        id,host_id,product_id,first_seen_at,last_seen_at
      ) VALUES ('install','host','product','2026-10-26','2026-10-26')`).run()
      old.db.prepare(`INSERT INTO projects(id,name,created_at,last_seen_at)
        VALUES ('project','Important Project','2026-10-26','2026-10-26')`).run()
      old.db.prepare(`INSERT INTO workspaces(id,host_id,project_id,path)
        VALUES ('workspace','host','project','C:/workspace')`).run()
      old.db.prepare(`INSERT INTO asset_definitions(id,type,canonical_name)
        VALUES ('asset','skill','my-skill')`).run()
      old.db.prepare(`INSERT INTO asset_bindings(id,asset_id,installation_id,scope)
        VALUES ('binding','asset','install','installation')`).run()
      old.db.prepare(`INSERT INTO asset_state_observations(
        id,asset_binding_id,state,value,observed_at
      ) VALUES ('old-state','binding','enabled','true','2026-10-26')`).run()
      old.db.prepare(`INSERT INTO asset_current_state(
        asset_binding_id,state,observation_id,value,observed_at
      ) VALUES ('binding','enabled','old-state','true','2026-10-26')`).run()
      old.db.prepare(`INSERT INTO logical_sessions(
        id,installation_id,project_id,workspace_id,title,title_kind
      ) VALUES ('logical','install','project','workspace','My title','explicit')`).run()
      old.db.prepare(`INSERT INTO source_sessions(
        id,source_id,installation_id,native_session_id,logical_session_id
      ) VALUES ('source','pi','install','session','logical')`).run()
      old.db.prepare(`INSERT INTO logical_sessions(
        id,installation_id,project_id,workspace_id,title,title_kind
      ) VALUES (
        'unverified','install','project','workspace','PRIVATE FIRST USER MESSAGE','unverified'
      )`).run()
      old.db.prepare(`INSERT INTO source_sessions(
        id,source_id,installation_id,native_session_id,logical_session_id
      ) VALUES ('unverified-source','pi','install','session-unverified','unverified')`).run()
      old.db.prepare(`INSERT INTO source_records(
        id,source_id,installation_id,native_type,captured_at,locator_json,
        payload_json,parser_version
      ) VALUES (
        'raw','pi','install','message','2026-10-26','{}',
        '{"text":"PRIVATE TRANSCRIPT"}','v1'
      )`).run()
      old.db.prepare(`INSERT INTO native_session_catalog(
        source_id,installation_id,native_session_id,location_kind,
        file_path,file_identity,file_size,file_mtime_ms,
        last_activity_at,updated_at,review_session_id
      ) VALUES (
        'pi','install','session','native','C:/native/session.jsonl',
        '1:1',200,1,'2026-10-26','2026-10-26','native:abc'
      )`).run()
    } finally {
      await old.close()
    }
    const report = await stageSlimCutover({ legacyPath, backupPath, stagingPath })
    assert.equal(report.readyToSwitch, false)
    assert.equal(report.source.legacySchemaVersion, 38)
    assert.equal(report.source.verifiedOriginalSourceRecovery, false)
    assert.equal(report.copiedRows.native_session_catalog, 0)
    assert.equal(report.copiedRows.native_session_metrics, 0)
    assert.equal(report.nativeCatalogReindexRequired,true)
    assert.equal(report.copiedRows.native_session_context, 2)
    assert.equal(report.copiedRows.asset_current_state, 1)
    const backup = new Database(backupPath, { readonly:true, fileMustExist:true })
    try {
      assert.equal((backup.prepare('SELECT payload_json FROM source_records')
        .get() as {payload_json:string}).payload_json.includes('PRIVATE TRANSCRIPT'), true)
    } finally {
      backup.close()
    }
    const stage = new Database(stagingPath, { readonly:true, fileMustExist:true })
    try {
      assertSlimSchema(stage)
      // Stale old DB file paths must not be advertised as verified native
      // entries. The new indexer will recreate locations from the Source.
      assert.equal((stage.prepare('SELECT COUNT(*) AS c FROM native_session_catalog')
        .get() as {c:number}).c,0)
      const rows = stage.prepare(`SELECT project_id,workspace_id,title_override
        FROM native_session_context WHERE native_session_id='session'`).all()
      assert.deepEqual(rows, [{
        project_id: 'project', workspace_id: 'workspace', title_override: 'My title',
      }])
      assert.deepEqual(stage.prepare('SELECT state_id,value FROM asset_current_state').all(), [
        { state_id:'old-state', value:'true' },
      ])
      const unsafeTitle = stage.prepare(`SELECT title_override,title_kind FROM native_session_context
        WHERE native_session_id='session-unverified'`).get() as {
          title_override:string|null;title_kind:string|null
        }
      assert.deepEqual(unsafeTitle,{title_override:null,title_kind:null})
      assert.equal((stage.prepare('SELECT COUNT(*) AS c FROM native_session_metrics')
        .get() as {c:number}).c, 0) // Must be recalculated from native source.
      assert.deepEqual(stage.pragma('foreign_key_check'), [])
      assert.equal(JSON.stringify(stage.prepare(`SELECT sql FROM sqlite_master`).all())
        .includes('PRIVATE TRANSCRIPT'), false)
    } finally {
      stage.close()
    }
    // Existing staging or backups are never overwritten.
    await assert.rejects(
      stageSlimCutover({ legacyPath, backupPath, stagingPath }),
      /EEXIST/,
    )
    await assert.rejects(
      stageSlimCutover({ legacyPath, backupPath, stagingPath: legacyPath }),
      /distinct/,
    )
  } finally {
    await rm(dir, { recursive:true, force:true })
  }
})
