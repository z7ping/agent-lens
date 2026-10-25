import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInstallation, Host } from '@agent-lens/core'
import { NativeReaderWorkerClient } from '@agent-lens/core-services'
import { piManifest } from '@agent-lens/source-pi'
import { codexManifest } from '@agent-lens/source-codex'
import { claudeManifest } from '@agent-lens/source-claude'
import { hermesManifest } from '@agent-lens/source-hermes'
import { openCodeManifest } from '@agent-lens/source-opencode'
import { HERMES_STATE_DB_NAME, OPENCODE_DB_NAME } from '@agent-lens/runtime-cordis'
import { DatabaseSync } from 'node:sqlite'
import { archiveAcceptedHookInboxFile } from '@agent-lens/source-support'

const now = '2026-10-25T00:00:00Z'
const host: Host = {
  id: 'local-host', name: 'test', platform: process.platform, arch: process.arch,
  createdAt: now, lastSeenAt: now,
}
function installation(productId: string, root: string): AgentInstallation {
  return {
    id: `${productId}-install`, hostId: host.id, productId, dataRoot: root,
    configRoot: root, firstSeenAt: now, lastSeenAt: now,
  }
}

test('isolated Pi native Worker reads and normalizes actual JSONL without a database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-native-worker-'))
  const filePath = join(root, 'pi.jsonl')
  const worker = new NativeReaderWorkerClient()
  try {
    await writeFile(filePath, [
      JSON.stringify({ type: 'session', id: 'native-session', cwd: root }),
      JSON.stringify({ type: 'message', id: 'message-1',
        message: { role: 'user', content: 'test native worker' } }),
    ].join('\n') + '\n')
    const fileStat = await stat(filePath)
    const fileIdentity = `${fileStat.dev}:${fileStat.ino}`
    const result = await worker.read({
      sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('pi', root),
      query: { filePath, nativeSessionId: 'native-session', limit: 10 },
    }, new AbortController().signal)
    assert.equal(result.state, 'available')
    if (result.state !== 'available') return
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]?.sourceId, 'pi')
    assert.ok(result.entries[1]?.recordId)
    assert.equal(result.entries[0]?.recordCursor?.offset,0)
    assert.equal(result.entries[0]?.recordCursor?.sequence,0)
    assert.equal(result.entries[1]?.recordCursor?.sequence,1)
    assert.equal(result.entries[1]?.recordCursor?.fileIdentity,fileIdentity)
    assert.ok(result.entries[1]?.normalized.observations.some(item => item.kind === 'message.user'))
    assert.equal(result.hasMore, false)
    assert.equal(result.pendingTail, false)

    const bad = await worker.read({
      sourceId: 'pi', parserVersion: 'outdated', expectedFileIdentity: fileIdentity,
      host, installation: installation('pi', root),
      query: { filePath, nativeSessionId: 'native-session' },
    }, new AbortController().signal)
    assert.deepEqual(bad, { state: 'unsupported', reason: 'native-worker-parser-version-mismatch' })
  } finally {
    await worker.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('isolated native Reader supports two shared SQLite sources by session identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-native-sqlite-worker-'))
  const worker=new NativeReaderWorkerClient()
  try{
    const hermesDbPath=join(root,HERMES_STATE_DB_NAME)
    const hermesDb=new DatabaseSync(hermesDbPath)
    hermesDb.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,title TEXT);
      CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT,timestamp TEXT)`)
    hermesDb.prepare('INSERT INTO sessions VALUES (?,?,?)').run('H1',root,'Hermes')
    hermesDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('h1','H1','user','"test"',now)
    hermesDb.close()
    const openCodeDbPath=join(root,OPENCODE_DB_NAME)
    const openCodeDb=new DatabaseSync(openCodeDbPath)
    openCodeDb.exec(`CREATE TABLE session(id TEXT,directory TEXT,title TEXT);
      CREATE TABLE message(id TEXT,data TEXT);
      CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)`)
    openCodeDb.prepare('INSERT INTO session VALUES (?,?,?)').run('O1',root,'OpenCode')
    openCodeDb.prepare('INSERT INTO message VALUES (?,?)').run('m1','{"role":"user"}')
    openCodeDb.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1','m1','O1',1234,'{"type":"text","text":"test"}')
    openCodeDb.close()
    for(const item of [
      {sourceId:'hermes',parserVersion:hermesManifest.parserVersion,filePath:hermesDbPath,nativeSessionId:'H1'},
      {sourceId:'opencode',parserVersion:openCodeManifest.parserVersion,filePath:openCodeDbPath,nativeSessionId:'O1'},
    ]){
      const info=await stat(item.filePath)
      const result=await worker.read({
        sourceId:item.sourceId,
        parserVersion:item.parserVersion,
        expectedFileIdentity:`${info.dev}:${info.ino}`,
        host,installation:installation(item.sourceId,root),
        query:{filePath:item.filePath,nativeSessionId:item.nativeSessionId,limit:8},
      },new AbortController().signal)
      assert.equal(result.state,'available',item.sourceId)
      if(result.state!=='available')continue
      assert.equal(result.entries.length,1,item.sourceId)
      assert.equal(result.entries[0]?.sourceSessionNativeId,item.nativeSessionId)
      assert.equal(result.entries[0]?.recordCursor?.offset,0)
      assert.equal(result.hasMore,false)
    }
  }finally{
    await worker.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('isolated Claude native Reader uses the same source normalizer and trusted project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-claude-native-worker-'))
  const projects = join(root, 'projects')
  const filePath = join(projects, 'claude-session.jsonl')
  const worker = new NativeReaderWorkerClient()
  try {
    await mkdir(projects, { recursive: true })
    await writeFile(filePath, [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({
        type: 'user', sessionId: 'claude-session', uuid: 'u1', cwd: root,
        message: { role: 'user', content: 'hello from Claude original JSONL' },
      }),
    ].join('\n') + '\n')
    const info = await stat(filePath)
    const fileIdentity = `${info.dev}:${info.ino}`
    const result = await worker.read({
      sourceId: 'claude-code',
      parserVersion: claudeManifest.parserVersion,
      expectedFileIdentity: fileIdentity,
      host,
      installation: {
        ...installation('claude-code', projects),
        configRoot: root,
      },
      query: { filePath, nativeSessionId: 'claude-session', limit: 8 },
    }, new AbortController().signal)
    assert.equal(result.state, 'available')
    if (result.state !== 'available') return
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]?.recordCursor?.sequence, 1)
    assert.equal(result.entries[1]?.recordCursor?.fileIdentity, fileIdentity)
    assert.equal(result.entries[1]?.normalized.observations.some(x => x.kind === 'message.user'), true)
    assert.equal(result.pendingTail, false)

    const foreign = await worker.read({
      sourceId: 'claude-code', parserVersion: claudeManifest.parserVersion,
      expectedFileIdentity: fileIdentity, host,
      installation: { ...installation('claude-code', projects), configRoot: root },
      query: { filePath: join(root, 'foreign.jsonl'), nativeSessionId: 'claude-session' },
    }, new AbortController().signal)
    assert.notEqual(foreign.state, 'available')
  } finally {
    await worker.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('isolated Codex native Worker reads original archived_sessions and validates source path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-native-worker-'))
  const archive = join(root, 'archived_sessions')
  const filePath = join(archive, 'rollout.jsonl')
  const worker = new NativeReaderWorkerClient()
  try {
    await mkdir(archive, { recursive: true })
    await writeFile(filePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-original', cwd: root } }),
      JSON.stringify({ type: 'response_item', timestamp: now,
        payload: { type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'worker output' }] } }),
    ].join('\n') + '\n')
    const fileStat = await stat(filePath)
    const fileIdentity = `${fileStat.dev}:${fileStat.ino}`
    const result = await worker.read({
      sourceId: 'codex', parserVersion: codexManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('codex', root),
      query: { filePath, nativeSessionId: 'codex-original', limit: 16 },
    }, new AbortController().signal)
    assert.equal(result.state, 'available')
    if (result.state === 'available') {
      assert.ok(result.entries.some(row => row.normalized.observations.some(x => x.kind === 'message.assistant')))
    }
    const escaped = await worker.read({
      sourceId: 'codex', parserVersion: codexManifest.parserVersion, expectedFileIdentity: fileIdentity,
      host, installation: installation('codex', join(root, 'another-root')),
      query: { filePath, nativeSessionId: 'codex-original' },
    }, new AbortController().signal)
    assert.deepEqual(escaped, { state: 'unsupported', reason: 'source-path-not-authorized' })
  } finally {
    await worker.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('native Worker cancellation and termination cannot leave a pending read alive', async () => {
  const client = new NativeReaderWorkerClient()
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(client.read({
    sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: 'missing',
    host, installation: installation('pi', '/missing'),
    query: { filePath: '/missing.jsonl', nativeSessionId: 'session' },
  }, aborted.signal))
  await client.dispose()
  await assert.rejects(client.read({
    sourceId: 'pi', parserVersion: piManifest.parserVersion, expectedFileIdentity: 'missing',
    host, installation: installation('pi', '/missing'),
    query: { filePath: '/missing.jsonl', nativeSessionId: 'session' },
  }, new AbortController().signal))
})

test('Hook native Worker isolates Hermes per-session archive and preserves bounded continuation',async()=>{
  const inbox=await mkdtemp(join(tmpdir(),'agent-lens-hook-worker-'))
  const previous=process.env.AGENT_LENS_HERMES_INBOX
  process.env.AGENT_LENS_HERMES_INBOX=inbox
  const worker=new NativeReaderWorkerClient()
  try{
    for(let i=0;i<17;i++){
      const fileName=`event-${String(i).padStart(3,'0')}.json`
      await writeFile(join(inbox,fileName),JSON.stringify({
        id:'h-'+i,
        event:{hook_event_name:'pre_approval_request',session_id:'H-original',
          tool_name:'shell',timestamp:now},
      }))
      await archiveAcceptedHookInboxFile({inbox,fileName,nativeSessionId:'H-original'})
    }
    const input={
      sourceId:'hermes',parserVersion:hermesManifest.parserVersion,
      nativeSessionId:'H-original',
      host,installation:installation('hermes',inbox),
    }
    const first=await worker.readHooks(input,new AbortController().signal)
    assert.equal(first.state,'available')
    if(first.state!=='available')return
    assert.equal(first.entries.length,16)
    assert.equal(first.hasMore,true)
    assert.ok(first.nextCursor)
    assert.equal(first.entries[0]?.normalized.observations[0]?.kind,'permission.request')
    const second=await worker.readHooks({
      ...input,cursor:first.nextCursor,
    },new AbortController().signal)
    assert.equal(second.state,'available')
    if(second.state!=='available')return
    assert.equal(second.entries.length,1)
    assert.equal(second.hasMore,false)
    const wrong=await worker.readHooks({
      ...input,nativeSessionId:'H-other',cursor:first.nextCursor,
    },new AbortController().signal)
    assert.deepEqual(wrong,{state:'unsupported',reason:'native-hook-cursor-invalid'})
    const wrongParser=await worker.readHooks({
      ...input,parserVersion:'outdated',
    },new AbortController().signal)
    assert.deepEqual(wrongParser,{state:'unsupported',reason:'native-worker-parser-version-mismatch'})
  }finally{
    await worker.dispose()
    if(previous===undefined)delete process.env.AGENT_LENS_HERMES_INBOX
    else process.env.AGENT_LENS_HERMES_INBOX=previous
    await rm(inbox,{recursive:true,force:true})
  }
})

