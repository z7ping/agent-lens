import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext } from '@agent-lens/core'
import { archiveAcceptedHookInboxFile } from '@agent-lens/source-support'
import { claudeSourceDefinition } from './index'

test('claude retrieves only its matching durable original Hook sidecar records',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-claude-hook-read-'))
  const before=process.env.AGENT_LENS_CLAUDE_INBOX
  process.env.AGENT_LENS_CLAUDE_INBOX=inbox
  const at='2026-10-25T10:00:00.000Z'
  const host={id:'host',name:'local',platform:process.platform,arch:process.arch,
    createdAt:at,lastSeenAt:at}
  const installation={id:'install',hostId:host.id,productId:'claude-code',
    dataRoot:inbox,firstSeenAt:at,lastSeenAt:at}
  const ctx={host,installation,abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},async clear(){}}} as unknown as SourceExecutionContext
  try {
    await writeFile(join(inbox,'one.json'),JSON.stringify({id:'hook-1',capturedAt:at,
      event:{session_id:'S1',hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'call-1'}}))
    await archiveAcceptedHookInboxFile({inbox,fileName:'one.json',nativeSessionId:'S1',installationId:'install'})
    const rows=await claudeSourceDefinition.readArchivedNativeHooks!('S1',ctx)
    assert.equal(rows.length,1)
    assert.equal(rows[0]?.sourceSessionNativeId,'S1')
    assert.equal(rows[0]?.installationId,'install')
    assert.equal(rows[0]?.locator.kind,'runtime-hook')
    assert.ok(rows[0]?.locator.path)
    const originalBytes=await readFile(rows[0]!.locator.path!)
    const fingerprint=createHash('sha256').update(originalBytes).digest('hex')
    assert.equal(rows[0]?.fingerprint,fingerprint,
      'the Source-owned archived Hook must retain recoverable original provenance')
    const archived=rows[0]!
    assert.equal((await claudeSourceDefinition.rawRecovery!.verify!(archived,ctx)).state,'verified')
    assert.equal((await claudeSourceDefinition.rawRecovery!.verify!({
      ...archived,fingerprint:'0'.repeat(64),
    },ctx)).state,'drifted')
    const normalized=await claudeSourceDefinition.normalize(rows[0]!,{host,installation})
    assert.ok(Array.isArray(normalized.observations))
    const permission=await claudeSourceDefinition.normalize({
      ...rows[0]!,payload:{runtimeEvent:{hook_event_name:'PermissionRequest',
        session_id:'S1',tool_use_id:'call-1',tool_name:'Read'},
        session:{nativeSessionId:'S1'}},
    },{host,installation})
    assert.equal(permission.observations[0]?.kind,'permission.request')
    assert.equal(permission.observations[0]?.nativeCallId,'call-1')
    assert.deepEqual(await claudeSourceDefinition.readArchivedNativeHooks!('other-session',ctx),[])
    await writeFile(join(inbox,'wrong.json'),JSON.stringify({id:'wrong-hook',capturedAt:at,
      event:{session_id:'S2',hook_event_name:'PreToolUse'}}))
    await archiveAcceptedHookInboxFile({inbox,fileName:'wrong.json',nativeSessionId:'S1',installationId:'install'})
    await assert.rejects(claudeSourceDefinition.readArchivedNativeHooks!('S1',ctx),/does not belong/)
  } finally {
    if(before===undefined) delete process.env.AGENT_LENS_CLAUDE_INBOX
    else process.env.AGENT_LENS_CLAUDE_INBOX=before
    await rm(inbox,{recursive:true,force:true})
  }
})
