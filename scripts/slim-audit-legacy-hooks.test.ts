import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorageService,SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { auditLegacyHookOriginals,parseHookAuditArgs } from './slim-audit-legacy-hooks'

test('old Hook audit validates explicit paths and bounded record budget',()=>{
  assert.throws(()=>parseHookAuditArgs([]),/explicit --legacy and --staging/)
  assert.throws(()=>parseHookAuditArgs(['--legacy','x.db','--staging','x.db']),/distinct/)
  assert.throws(()=>parseHookAuditArgs(['--legacy','x.db','--staging','y.db',
    '--max-records','5001']),/1-5000/)
})
test('Hook audit reads locator metadata but never exposes prior payloads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'al-hooks-'))
  const legacyPath=join(dir,'legacy.sqlite'),stagingPath=join(dir,'slim.sqlite')
  try{
    const old=new SqliteStorageService({path:legacyPath})
    await old.migrate()
    old.db.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at)
      VALUES('host','host','linux','x64','2026-10-26','2026-10-26')`).run()
    old.db.prepare(`INSERT INTO agent_products(id,name) VALUES('codex','Codex')`).run()
    old.db.prepare(`INSERT INTO agent_installations(id,host_id,product_id,first_seen_at,last_seen_at)
      VALUES('unmapped','host','codex','2026-10-26','2026-10-26')`).run()
    old.db.prepare(`INSERT INTO source_records(
      id,source_id,installation_id,native_type,captured_at,locator_json,
      payload_json,parser_version,source_session_native_id,fingerprint
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      'record','codex','unmapped','permission','2026-10-26',
      JSON.stringify({kind:'runtime-hook',path:'/not-a-valid-hook.json'}),
      '{"text":"PRIVATE HOOK CONTENT"}','1','old-secret-session','abc')
    await old.close()
    const slim=await SqliteSlimStorage.createFresh(stagingPath)
    await slim.close()
    const audit=await auditLegacyHookOriginals(['--legacy',legacyPath,'--staging',stagingPath])
    assert.equal(audit.found,1)
    assert.equal(audit.verified,0)
    assert.equal(audit.unsupported,1)
    assert.equal(audit.allLegacyHookOriginalsVerified,false)
    assert.equal(audit.scanComplete,true)
    assert.equal(JSON.stringify(audit).includes('PRIVATE HOOK CONTENT'),false)
    assert.equal(JSON.stringify(audit).includes('old-secret-session'),false)
    assert.equal(JSON.stringify(audit).includes('/not-a-valid-hook'),false)
  }finally{await rm(dir,{recursive:true,force:true})}
})
