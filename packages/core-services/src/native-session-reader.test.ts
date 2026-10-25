import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService,
  NativeSessionCatalogEntry,
  SourceDefinition,
  SourceRecord,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import { NativeSessionReader } from './native-session-reader'

const at = '2026-10-25T00:00:00Z'
const host = { id: 'host', name: 'local', platform: 'linux', arch: 'x64', createdAt: at, lastSeenAt: at }
const installation = { id: 'install', hostId: host.id, productId: 'pi', dataRoot: '/sessions',
  firstSeenAt: at, lastSeenAt: at }
const catalog: NativeSessionCatalogEntry = {
  sourceId: 'pi', installationId: 'install', nativeSessionId: 'S1',
  locationKind: 'native', filePath: '/sessions/S1.jsonl', fileIdentity: '1:9',
  fileSize: 250, fileMtimeMs: 4, lastActivityAt: at, updatedAt: at,
}
const raw: SourceRecord = {
  id: 'record', sourceId: 'pi', installationId: 'install', sourceSessionNativeId: 'S1',
  nativeType: 'history/message', sourceSequence: 1000, capturedAt: at,
  locator: { kind: 'file', path: catalog.filePath, offset: 0 },
  fingerprint: 'nativefingerprint', parserVersion: '1',
  payload: { entry: { type: 'message', text: 'secret' }, session: { nativeSessionId: 'S1' } },
}
const sample = {
  kind: 'message.user' as const,
  sourceSequence: 1000,
  capturedAt: at,
  payload: { text: 'secret' },
  identityHints: { nativeSessionId: 'S1' },
}

function fixture(opts: { enabled?: boolean; catalogEntry?: NativeSessionCatalogEntry | null;
  identity?: string; sourceId?: string; rawMediaBytes?: number; normalizedMediaBytes?: number } = {}) {
  const calls = { catalog: 0, source: 0, normalize: 0, sanitized: 0 }
  const storage = {
    nativeSessionCatalog: { async get() { calls.catalog++; return opts.catalogEntry === undefined ? catalog : opts.catalogEntry } },
    repositories: {
      installations: { async get() { return installation } },
      hosts: { async get() { return host } },
    },
  } as unknown as StorageService
  const source = {
    manifest: { sourceId: 'pi', productId: 'pi' },
    async readNativeSessionPage(query: { filePath: string; nativeSessionId: string },
      ctx: { checkpoint: { set(key: string, value: unknown): Promise<void> } }) {
      calls.source++
      assert.equal(query.filePath, catalog.filePath)
      assert.equal(query.nativeSessionId, 'S1')
      // The renderer cannot mutate history checkpoints.
      await assert.rejects(ctx.checkpoint.set('cursor', 123), /cannot persist/)
      return {
        state: 'available' as const,
        records: [{ ...raw, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
          ...(opts.rawMediaBytes ? { payload: { bytes: 'x'.repeat(opts.rawMediaBytes) } } : {}) }],
        recordCursors: [{ offset: 0, sequence: 0, fileIdentity: opts.identity ?? '1:9' }],
        nextCursor: { offset: 50, sequence: 1, fileIdentity: opts.identity ?? '1:9' },
        hasMore: true, pendingTail: false,
      }
    },
    async normalize() {
      calls.normalize++
      return { observations: [opts.normalizedMediaBytes
        ? { ...sample, payload: { imageData: 'x'.repeat(opts.normalizedMediaBytes) } }
        : sample], evidenceCandidates: [] }
    },
  } as unknown as SourceDefinition
  const sources = { list: () => [source] } as unknown as SourceService
  const policy = {
    isSourceEnabled: () => opts.enabled !== false,
    isEnabled: () => opts.enabled !== false,
    sanitizeNormalizedOutput(input: { observations: typeof sample[]; evidenceCandidates: unknown[] }) {
      calls.sanitized++
      return { ...input, observations: input.observations.map(observation => ({
        ...observation, payload: { text: '[redacted]' },
      })) }
    },
  } as unknown as CapturePolicyService
  return { reader: new NativeSessionReader(storage, sources, policy), calls }
}

const query = { sourceId: 'pi', installationId: 'install', nativeSessionId: 'S1',
  signal: new AbortController().signal }

test('native reader resolves trusted Catalog path and sanitizes canonical candidates without persistence', async () => {
  const { reader, calls } = fixture()
  const output = await reader.read(query)
  assert.equal(output.state, 'available')
  if (output.state !== 'available') return
  assert.equal(output.observations[0]?.kind, 'message.user')
  assert.deepEqual(output.observations[0]?.payload, { text: '[redacted]' })
  assert.equal(output.nextCursor.offset, 50)
  assert.deepEqual(output.observationCursors, [{offset:0,sequence:0,fileIdentity:'1:9'}])
  assert.equal(output.hasMore, true)
  assert.deepEqual(calls, { catalog: 1, source: 1, normalize: 1, sanitized: 1 })
})

test('native reader fails closed for disabled source, missing session, replaced file and foreign events', async () => {
  const disabled = fixture({ enabled: false })
  assert.deepEqual(await disabled.reader.read(query), { state: 'unsupported', reason: 'source-disabled' })
  assert.equal(disabled.calls.catalog, 0)

  const missing = fixture({ catalogEntry: null })
  assert.deepEqual(await missing.reader.read(query),
    { state: 'unavailable', reason: 'native-session-not-indexed' })
  assert.equal(missing.calls.source, 0)

  const drifted = fixture({ identity: '2:20' })
  assert.deepEqual(await drifted.reader.read(query),
    { state: 'drifted', reason: 'native-catalog-file-identity-changed' })
  assert.equal(drifted.calls.normalize, 0)

  const foreign = fixture({ sourceId: 'other' })
  assert.deepEqual(await foreign.reader.read(query),
    { state: 'drifted', reason: 'native-record-identity-changed' })
  assert.equal(foreign.calls.sanitized, 0)

  const invalid = fixture()
  assert.deepEqual(await invalid.reader.read({ ...query, limit: 65 }),
    { state: 'unsupported', reason: 'native-window-limit-invalid' })
  assert.equal(invalid.calls.catalog, 0)

  const signal = new AbortController()
  signal.abort()
  const cancelled = fixture()
  await assert.rejects(cancelled.reader.read({ ...query, signal: signal.signal }))
  assert.equal(cancelled.calls.catalog, 0)
})


test('native reader uses isolated worker for supported sources and still sanitizes on the parent', async () => {
  const baseline = fixture()
  const { reader: _old, ...unused } = baseline
  assert.ok(unused)
  let sourceRead = 0
  let workerRead = 0
  let sanitized = 0
  const storage = {
    nativeSessionCatalog: { async get() { return catalog } },
    repositories: {
      installations: { async get() { return installation } },
      hosts: { async get() { return host } },
    },
  } as unknown as StorageService
  const sources = { list: () => [{
    manifest: { sourceId: 'pi', productId: 'pi', parserVersion: 'current' },
    async readNativeSessionPage() { sourceRead++; throw Error('main thread Source read is forbidden') },
    async normalize() { throw Error('main thread normalizer is forbidden') },
  }] } as unknown as SourceService
  const policy = {
    isSourceEnabled: () => true,
    sanitizeNormalizedOutput(input: { observations: typeof sample[]; evidenceCandidates: unknown[] }) {
      sanitized++
      return { ...input, observations: input.observations.map(item => ({
        ...item, payload: { text: '[parent-redacted]' },
      })) }
    },
  } as unknown as CapturePolicyService
  const worker = {
    supports: (sourceId: string) => sourceId === 'pi',
    async read(input: {sourceId:string; parserVersion:string; query:{filePath:string}}, signal:AbortSignal) {
      workerRead++
      assert.equal(input.sourceId, 'pi')
      assert.equal(input.parserVersion, 'current')
      assert.equal(input.query.filePath, catalog.filePath)
      assert.equal(signal.aborted, false)
      return {
        state: 'available' as const,
        entries: [{
          recordId: 'worker-record',
          recordCursor: {offset:0,sequence:0,fileIdentity:catalog.fileIdentity},
          sourceId: 'pi', installationId: installation.id,
          sourceSessionNativeId: catalog.nativeSessionId,
          normalized: { observations: [sample], evidenceCandidates: [] },
        }],
        nextCursor: { offset: 99, sequence: 2, fileIdentity: catalog.fileIdentity },
        hasMore: false, pendingTail: false,
      }
    },
  }
  const isolated = new NativeSessionReader(storage, sources, policy, worker)
  const output = await isolated.read(query)
  assert.equal(output.state,'available')
  if(output.state !== 'available') return
  assert.deepEqual(output.observationRecordIds, ['worker-record'])
  assert.deepEqual(output.observationCursors, [{offset:0,sequence:0,fileIdentity:'1:9'}])
  assert.deepEqual(output.observations[0]?.payload, {text:'[parent-redacted]'})
  assert.equal(workerRead, 1)
  assert.equal(sourceRead, 0)
  assert.equal(sanitized, 1)
})

test('native lazy-media reader returns only one verified original Source record without persisting text',async()=>{
  const {reader,calls}=fixture()
  const offset={offset:0,sequence:0,fileIdentity:'1:9'}
  const result=await reader.readUnpersistedMediaPage({...query,cursor:offset})
  assert.equal(result.state,'available')
  if(result.state!=='available')return
  assert.deepEqual(result.observationCursors,[offset])
  assert.deepEqual(result.observationRecordIds,['record'])
  assert.deepEqual(result.observations[0]?.payload,{text:'secret'})
  assert.deepEqual(result.evidenceCandidates,[])
  assert.deepEqual(calls,{catalog:1,source:1,normalize:1,sanitized:0})
  const bad=await fixture().reader.readUnpersistedMediaPage({
    ...query,cursor:{offset:0,sequence:0,fileIdentity:'forged'},
  })
  assert.deepEqual(bad,{state:'unsupported',reason:'native-attachment-cursor-invalid'})
  const disabled=await fixture({enabled:false}).reader.readUnpersistedMediaPage({...query,cursor:offset})
  assert.deepEqual(disabled,{state:'unsupported',reason:'native-attachment-capture-disabled'})
  const drift=await fixture({identity:'other'}).reader.readUnpersistedMediaPage({...query,cursor:offset})
  assert.deepEqual(drift,{state:'drifted',reason:'native-attachment-record-identity-changed'})
})

test('native media hydration refuses oversized original and normalized images before public DTO', async () => {
  const cursor = {offset:0,sequence:0,fileIdentity:'1:9'}
  const raw = fixture({rawMediaBytes:3*1024*1024+1})
  assert.deepEqual(await raw.reader.readUnpersistedMediaPage({...query,cursor}), {
    state:'unsupported',reason:'native-attachment-source-payload-too-large',
  })
  assert.equal(raw.calls.normalize,0, 'oversized native payload must not be normalized')

  const normalized = fixture({normalizedMediaBytes:3*1024*1024+1})
  assert.deepEqual(await normalized.reader.readUnpersistedMediaPage({...query,cursor}), {
    state:'unsupported',reason:'native-attachment-normalized-payload-too-large',
  })
  assert.equal(normalized.calls.normalize,1)
  assert.equal(normalized.calls.sanitized,0)
})

test('Hook archive reader uses Catalog Source authority, sanitizes and forbids foreign Hook records',async()=>{
  let reads=0
  const nativeSource={
    manifest:{sourceId:'pi',productId:'pi'},
    async readArchivedNativeHooks(_nativeSessionId:string){
      reads++
      return [{...raw,locator:{kind:'runtime-hook' as const,hookEventId:'h1'}}]
    },
    async normalize(){return {observations:[sample],evidenceCandidates:[]}},
  } as unknown as SourceDefinition
  const stores={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},hosts:{async get(){return host}}},
  } as unknown as StorageService
  const policy={
    isSourceEnabled(){return true},
    sanitizeNormalizedOutput(){return {observations:[{...sample,payload:{text:'[redacted]'}}],evidenceCandidates:[]}},
  } as unknown as CapturePolicyService
  const r=new NativeSessionReader(stores,{list:()=>[nativeSource]} as unknown as SourceService,policy)
  const answer=await r.readArchivedHooks(query)
  assert.equal(answer.state,'available')
  if(answer.state==='available'){
    assert.deepEqual(answer.observations[0]?.payload,{text:'[redacted]'})
    assert.deepEqual(answer.observationRecordIds,['record'])
    assert.equal(answer.truncated,false)
    assert.equal(JSON.stringify(answer).includes('/sessions/'),false)
  }
  assert.equal(reads,1)
  nativeSource.readArchivedNativeHooks=async()=>[
    {...raw,sourceSessionNativeId:'foreign',locator:{kind:'runtime-hook',hookEventId:'h2'}},
  ]
  assert.deepEqual(await r.readArchivedHooks(query),
    {state:'drifted',reason:'native-hook-record-identity-drifted'})
})
