import { LegacyV38TestDatabase } from './legacy-v38-test-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { SqliteSlimStorage } from './slim-storage'
import { auditSlimCutoverFreshness } from './slim-cutover-freshness'

test('frozen old/backup row-digest agreement is reported without exposing row data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-slim-drift-'))
  const legacyPath=join(dir,'legacy.sqlite')
  const backupPath=join(dir,'backup.sqlite')
  const stagingPath=join(dir,'staging.sqlite')
  try{
    const legacy=new LegacyV38TestDatabase({path:legacyPath})
    await legacy.migrate()
    await legacy.close()
    await copyFile(legacyPath,backupPath)
    const stage=await SqliteSlimStorage.createFresh(stagingPath)
    await stage.close()
    const args={legacyPath,backupPath,stagingPath}
    const identical=await auditSlimCutoverFreshness(args)
    assert.equal(identical.legacySchemaVersion,38)
    assert.equal(identical.stagingSchemaVerified,true)
    assert.equal(identical.readyToSwitch,false)
    assert.equal(identical.changedTables.length,0)

    const changed=new Database(legacyPath)
    try{
      changed.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
        VALUES (?,?,?,?,?,?)`).run('h','secret machine','linux','x64',
          '2026-10-26','2026-10-26')
    }finally{changed.close()}
    const drift=await auditSlimCutoverFreshness(args)
    assert.equal(drift.unchangedSinceBackup,false)
    assert.equal(drift.changedTables.some(item=>item.table==='hosts'
      && item.backupRows===0 && item.currentRows===1),true)
    assert.equal(JSON.stringify(drift).includes('secret machine'),false)
    assert.equal(JSON.stringify(drift).includes(legacyPath),false)
    assert.equal(drift.readyToSwitch,false)
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('freshness audit refuses missing databases rather than creating replacements',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-slim-reject-'))
  try{
    await assert.rejects(auditSlimCutoverFreshness({
      legacyPath:join(dir,'missing.sqlite'),backupPath:join(dir,'backup.sqlite'),
      stagingPath:join(dir,'stage.sqlite'),
    }),/unable to open|does not exist|not found/i)
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('freshness detects every v38 event/sidecar table and schema-only change',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-slim-schema-drift-'))
  const legacyPath=join(dir,'legacy.sqlite')
  const backupPath=join(dir,'backup.sqlite')
  const stagingPath=join(dir,'staging.sqlite')
  try{
    const service=new LegacyV38TestDatabase({path:legacyPath})
    await service.migrate()
    await service.close()
    await copyFile(legacyPath,backupPath)
    const stage=await SqliteSlimStorage.createFresh(stagingPath)
    await stage.close()
    const db=new Database(legacyPath)
    try{
      db.exec('CREATE TABLE migration_coverage_probe (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
      db.prepare('INSERT INTO migration_coverage_probe VALUES (?,?)')
        .run('id-1','this value must not be logged')
    }finally{db.close()}
    const report=await auditSlimCutoverFreshness({legacyPath,backupPath,stagingPath})
    assert.equal(report.unchangedSinceBackup,false)
    assert.equal(report.schemaChanged,true)
    assert.ok(report.changedTables.some(row=>row.table==='migration_coverage_probe'
      && row.currentRows===1&&row.backupRows===0))
    assert.equal(JSON.stringify(report).includes('this value must not be logged'),false)
  }finally{await rm(dir,{recursive:true,force:true})}
})
