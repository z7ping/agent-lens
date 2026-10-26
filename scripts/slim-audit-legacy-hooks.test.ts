import { LegacyV38TestDatabase } from '../packages/storage-sqlite/src/legacy-v38-test-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {SqliteSlimStorage} from '@agent-lens/storage-sqlite'
import { auditLegacyHookOriginals,parseHookAuditArgs } from './slim-audit-legacy-hooks'
import { archiveAcceptedHookInboxFile } from '@agent-lens/source-support'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import {stageSlimCutover} from '@agent-lens/storage-sqlite'

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
    const old=new LegacyV38TestDatabase({path:legacyPath})
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

test('M3 旧 Hook 原件：真实归档通过，checksum 变化和原件丢失拒绝认证',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-m3-hook-real-'))
  const previousInbox=process.env.AGENT_LENS_CODEX_INBOX
  const previousSources=process.env.AGENT_LENS_ENABLED_SOURCES
  process.env.AGENT_LENS_CODEX_INBOX=root
  process.env.AGENT_LENS_ENABLED_SOURCES='codex'
  const legacyPath=join(root,'legacy.sqlite'),stagingPath=join(root,'stage.sqlite')
  const at='2026-10-26T00:00:00Z'
  try{
    const host={id:'h',name:'test',platform:process.platform,arch:process.arch,createdAt:at,lastSeenAt:at}
    const installation={id:'i',hostId:'h',productId:'codex',dataRoot:root,firstSeenAt:at,lastSeenAt:at}
    const context={host,installation,abortSignal:new AbortController().signal,
      checkpoint:{async get(){return null},async set(){},async clear(){}}}
    await writeFile(join(root,'one.json'),JSON.stringify({id:'hook-1',capturedAt:at,
      event:{session_id:'s',hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'call-1'}}))
    await archiveAcceptedHookInboxFile({inbox:root,fileName:'one.json',nativeSessionId:'s',installationId:'i'})
    const record=(await codexSourceDefinition.readArchivedNativeHooks!('s',context))[0]!
    assert.ok(record)
    const old=new LegacyV38TestDatabase({path:legacyPath})
    try{
      await old.migrate()
      old.db.prepare(`INSERT INTO hosts(id,name,platform,arch,created_at,last_seen_at) VALUES('h','test',?,?,?,?)`).run(process.platform,process.arch,at,at)
      old.db.prepare(`INSERT INTO agent_products(id,name) VALUES('codex','Codex')`).run()
      old.db.prepare(`INSERT INTO agent_installations(id,host_id,product_id,data_root,first_seen_at,last_seen_at) VALUES('i','h','codex',?,?,?)`).run(root,at,at)
      old.db.prepare(`INSERT INTO source_records(id,source_id,installation_id,source_session_native_id,native_type,captured_at,locator_json,payload_json,parser_version,fingerprint)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.id,record.sourceId,record.installationId,record.sourceSessionNativeId,record.nativeType,record.capturedAt,JSON.stringify(record.locator),'null',record.parserVersion,record.fingerprint)
    }finally{await old.close()}
    await stageSlimCutover({legacyPath,backupPath:join(root,'backup.sqlite'),stagingPath})
    const args=['--legacy',legacyPath,'--staging',stagingPath]
    const verified=await auditLegacyHookOriginals(args)
    assert.equal(verified.verified,1)
    assert.equal(verified.allLegacyHookOriginalsVerified,true)
    const bytes=await readFile(record.locator.path!)
    await writeFile(record.locator.path!,Buffer.concat([bytes,Buffer.from('changed')]))
    const changed=await auditLegacyHookOriginals(args)
    assert.equal(changed.allLegacyHookOriginalsVerified,false)
    assert.equal(changed.drifted,1)
    await rm(record.locator.path!)
    const missing=await auditLegacyHookOriginals(args)
    assert.equal(missing.allLegacyHookOriginalsVerified,false)
    assert.equal(missing.unavailable,1)
  }finally{
    if(previousInbox===undefined)delete process.env.AGENT_LENS_CODEX_INBOX;else process.env.AGENT_LENS_CODEX_INBOX=previousInbox
    if(previousSources===undefined)delete process.env.AGENT_LENS_ENABLED_SOURCES;else process.env.AGENT_LENS_ENABLED_SOURCES=previousSources
    await rm(root,{recursive:true,force:true})
  }
})
