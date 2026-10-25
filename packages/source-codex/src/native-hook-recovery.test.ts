import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext } from '@agent-lens/core'
import { archiveAcceptedHookInboxFile } from '@agent-lens/source-support'
import { codexSourceDefinition } from './index'

test('codex retrieves only its matching durable original Hook sidecar records',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'al-codex-hook-read-'))
  const before=process.env.AGENT_LENS_CODEX_INBOX
  process.env.AGENT_LENS_CODEX_INBOX=inbox
  const at='2026-10-25T10:00:00.000Z'
  const host={id:'host',name:'local',platform:process.platform,arch:process.arch,
    createdAt:at,lastSeenAt:at}
  const installation={id:'install',hostId:host.id,productId:'codex',
    dataRoot:inbox,firstSeenAt:at,lastSeenAt:at}
  const ctx={host,installation,abortSignal:new AbortController().signal,
    checkpoint:{async get(){return null},async set(){throw Error('read-only')},async clear(){}}} as unknown as SourceExecutionContext
  try {
    await writeFile(join(inbox,'one.json'),JSON.stringify({id:'hook-1',capturedAt:at,
      event:{session_id:'S1',hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'call-1'}}))
    await archiveAcceptedHookInboxFile({inbox,fileName:'one.json',nativeSessionId:'S1',installationId:'install'})
    const rows=await codexSourceDefinition.readArchivedNativeHooks!('S1',ctx)
    assert.equal(rows.length,1)
    assert.equal(rows[0]?.sourceSessionNativeId,'S1')
    assert.equal(rows[0]?.installationId,'install')
    assert.equal(rows[0]?.locator.kind,'runtime-hook')
    const normalized=await codexSourceDefinition.normalize(rows[0]!,{host,installation})
    assert.ok(Array.isArray(normalized.observations))
    assert.deepEqual(await codexSourceDefinition.readArchivedNativeHooks!('other-session',ctx),[])
    await writeFile(join(inbox,'wrong.json'),JSON.stringify({id:'wrong-hook',capturedAt:at,
      event:{session_id:'S2',hook_event_name:'PreToolUse'}}))
    await archiveAcceptedHookInboxFile({inbox,fileName:'wrong.json',nativeSessionId:'S1',installationId:'install'})
    await assert.rejects(codexSourceDefinition.readArchivedNativeHooks!('S1',ctx),/does not belong/)
  } finally {
    if(before===undefined) delete process.env.AGENT_LENS_CODEX_INBOX
    else process.env.AGENT_LENS_CODEX_INBOX=before
    await rm(inbox,{recursive:true,force:true})
  }
})
