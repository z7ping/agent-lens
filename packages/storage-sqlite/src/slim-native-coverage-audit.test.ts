import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteSlimStorage } from './slim-storage'
import { auditSlimNativeCoverage } from './slim-native-coverage-audit'

test('read-only cutover coverage differentiates native, archive and missing original identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-coverage-'))
  const oldPath=join(root,'legacy.sqlite'),slimPath=join(root,'slim.sqlite')
  try {
    const old=new Database(oldPath)
    try {
      old.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
        INSERT INTO schema_migrations VALUES (38,'latest','2026-10-26');
        CREATE TABLE source_sessions (
          id TEXT PRIMARY KEY,source_id TEXT,installation_id TEXT,native_session_id TEXT
        );
        INSERT INTO source_sessions VALUES('a','pi','install','one');
        INSERT INTO source_sessions VALUES('b','pi','install','two');
        INSERT INTO source_sessions VALUES('c','codex','install','secret-native-id');
        CREATE TABLE source_records (
          id TEXT PRIMARY KEY,source_id TEXT,installation_id TEXT,
          source_session_native_id TEXT,payload_json TEXT
        );
        INSERT INTO source_records VALUES ('record1','pi','install','one','private-mapped-message');
        INSERT INTO source_records VALUES ('record2','pi','install',NULL,'private-unmapped-hook');
        INSERT INTO source_records VALUES ('record3','pi','install','missing','private-unmapped-session');
      `)
    }finally{old.close()}
    const stage=await SqliteSlimStorage.createFresh(slimPath)
    try {
      stage.db.prepare(`INSERT INTO native_session_catalog(
        source_id,installation_id,native_session_id,location_kind,file_path,
        file_identity,file_size,file_mtime_ms,last_activity_at,updated_at
      ) VALUES ('pi','install','one','native','/safe/one.jsonl','1:2',123,100,'2026-10-26','2026-10-26')`).run()
      stage.db.prepare(`INSERT INTO native_session_catalog(
        source_id,installation_id,native_session_id,location_kind,file_path,
        file_identity,file_size,file_mtime_ms,last_activity_at,updated_at
      ) VALUES ('pi','install','two','archive','/safe/two.jsonl','1:3',123,100,'2026-10-26','2026-10-26')`).run()
    }finally{await stage.close()}
    const oldRead=new Database(oldPath,{readonly:true,fileMustExist:true})
    const slimRead=new Database(slimPath,{readonly:true,fileMustExist:true})
    try{
      const report=auditSlimNativeCoverage(oldRead,slimRead)
      assert.equal(report.oldSessionIdentities,3)
      assert.equal(report.nativeIndexed,1)
      assert.equal(report.archivedOnly,1)
      assert.equal(report.missingFromNativeCatalog,1)
      assert.equal(report.missingContext,3)
      assert.equal(report.legacyRecordsWithoutSession,2)
      assert.equal(report.nativeMetricsMissingOrStale,1)
      assert.equal(report.nativeContentFullyVerified,false)
      assert.equal(report.readyToSwitch,false)
      assert.equal(report.missingExamples.length,1)
      assert.equal(report.missingExamples[0]?.sourceId,'codex')
      assert.equal(report.missingExamples[0]?.opaqueSession.length,20)
      assert.equal(JSON.stringify(report).includes('secret-native-id'),false)
      assert.equal(JSON.stringify(report).includes('private-unmapped-hook'),false)
      assert.equal(JSON.stringify(report).includes('private-unmapped-session'),false)
      assert.equal(JSON.stringify(report).includes('/safe/'),false)
    }finally{oldRead.close();slimRead.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})

test('cutover coverage audit refuses writeable input and does not create fallback DB',async()=>{
  const db=new Database(':memory:')
  try{
    assert.throws(()=>auditSlimNativeCoverage(db,db),/read-only/)
  }finally{db.close()}
})
