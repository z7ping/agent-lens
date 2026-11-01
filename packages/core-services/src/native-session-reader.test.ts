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

test('Hook source pagination never reports success for unresumable or stagnant continuations',async()=>{
  const cursor=Buffer.from('old').toString('base64url')
  const next=Buffer.from('new').toString('base64url')
  let mode:'valid'|'missing'|'stalled'|'finished-with-cursor'='valid'
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    async readArchivedNativeHooksPage(_id:string, _ctx:unknown, after?:string){
      assert.equal(after,cursor)
      const records=[{...raw,locator:{kind:'runtime-hook' as const,hookEventId:'hook-1'}}]
      if(mode==='missing')return {records,hasMore:true}
      if(mode==='stalled')return {records,hasMore:true,nextCursor:cursor}
      if(mode==='finished-with-cursor')return {records,hasMore:false,nextCursor:next}
      return {records,hasMore:true,nextCursor:next}
    },
    async normalize(){return {observations:[sample],evidenceCandidates:[]}},
  } as unknown as SourceDefinition
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},hosts:{async get(){return host}}},
  } as unknown as StorageService
  const policy={
    isSourceEnabled(){return true},
    sanitizeNormalizedOutput(){return {observations:[{...sample,payload:{text:'[redacted]'}}],evidenceCandidates:[]}},
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,{list:()=>[source]} as unknown as SourceService,policy)
  const request={...query,cursor}
  const good=await reader.readArchivedHooks(request)
  assert.equal(good.state,'available')
  if(good.state==='available'){
    assert.equal(good.nextCursor,next)
    assert.equal(good.truncated,true)
    assert.deepEqual(good.observations[0]?.payload,{text:'[redacted]'})
  }
  mode='missing'
  assert.deepEqual(await reader.readArchivedHooks(request),
    {state:'unsupported',reason:'native-hook-next-cursor-invalid'})
  mode='stalled'
  assert.deepEqual(await reader.readArchivedHooks(request),
    {state:'unsupported',reason:'native-hook-next-cursor-invalid'})
  mode='finished-with-cursor'
  assert.deepEqual(await reader.readArchivedHooks(request),
    {state:'unsupported',reason:'native-hook-next-cursor-unexpected'})
})

test('Hook reader delegates isolated Source normalization to Worker then applies parent CapturePolicy',async()=>{
  let direct=0
  let workerCalls=0
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'1'},
    async readArchivedNativeHooksPage(){direct++;throw Error('HTTP thread must not parse Hook files')},
    async normalize(){direct++;throw Error('HTTP thread must not normalize Hook facts')},
  } as unknown as SourceDefinition
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},hosts:{async get(){return host}}},
  } as unknown as StorageService
  const policy={
    isSourceEnabled(){return true},
    sanitizeNormalizedOutput(input: {observations:typeof sample[]}) {
      return {...input,observations:input.observations.map(item=>({
        ...item,payload:{text:'[worker-redacted]'},
      }))}
    },
  } as unknown as CapturePolicyService
  const worker={
    supports(){return true},
    async read(){throw Error('Must use readHooks operation, not native transcript read')},
    async readHooks(input:{sourceId:string;nativeSessionId:string;cursor?:string}) {
      workerCalls++
      assert.equal(input.sourceId,'pi')
      assert.equal(input.nativeSessionId,'S1')
      assert.equal(input.cursor,'cursor-1')
      return {
        state:'available' as const,
        entries:[{
          sourceId:'pi',installationId:'install',sourceSessionNativeId:'S1',
          recordId:'native-hook-1',
          normalized:{observations:[sample],evidenceCandidates:[]},
        }],
        hasMore:false,
      }
    },
  }
  const reader=new NativeSessionReader(storage,{list:()=>[source]} as unknown as SourceService,policy,worker)
  const answer=await reader.readArchivedHooks({...query,cursor:'cursor-1'})
  assert.equal(answer.state,'available')
  if(answer.state==='available'){
    assert.deepEqual(answer.observations[0]?.payload,{text:'[worker-redacted]'})
    assert.deepEqual(answer.observationRecordIds,['native-hook-1'])
    assert.equal(answer.truncated,false)
  }
  assert.equal(direct,0)
  assert.equal(workerCalls,1)
})


test('native reader uses persisted Slim profile roots across Worker, Hook and media reads',async()=>{
  const resolvedRoots:string[]=[]
  const scopedProfile={
    id:'profile-1',installationId:'install',nativeProfileId:'profile-1',
    dataRoot:'/scoped-sessions',configRoot:'/profile-config',
    firstSeenAt:at,lastSeenAt:at,
  }
  const scopedCatalog={...catalog,filePath:'/scoped-sessions/S1.jsonl'}
  const storage={
    nativeSessionCatalog:{async get(){return scopedCatalog}},
    nativeSessionContexts:{async get(){return {runtimeProfileId:'profile-1'}}},
    runtimeProfiles:{async get(){return scopedProfile}},
    repositories:{
      installations:{async get(){return installation}},
      hosts:{async get(){return host}},
    },
  }
  const worker={
    supports(){return true},
    async read(input:{
      installation:{dataRoot?:string};runtimeProfile?:{id:string}
    }){
      resolvedRoots.push(input.installation.dataRoot??'')
      assert.equal(input.runtimeProfile?.id,'profile-1')
      return {
        state:'available' as const,entries:[],
        nextCursor:{offset:10,sequence:1,fileIdentity:'1:9'},
        hasMore:false,pendingTail:false,
      }
    },
    async readHooks(input:{
      installation:{dataRoot?:string};runtimeProfile?:{id:string}
    }){
      resolvedRoots.push(input.installation.dataRoot??'')
      assert.equal(input.runtimeProfile?.id,'profile-1')
      return {state:'available' as const,entries:[],hasMore:false}
    },
  }
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'v1'},
    readNativeSessionPage:async(
      _query:Parameters<NonNullable<SourceDefinition['readNativeSessionPage']>>[0],
      ctx:Parameters<NonNullable<SourceDefinition['readNativeSessionPage']>>[1],
    )=>{
      resolvedRoots.push(ctx.installation.dataRoot??'')
      assert.equal(ctx.runtimeProfile?.id,'profile-1')
      return {state:'available' as const,records:[],
        recordCursors:[],nextCursor:{offset:10,sequence:1,fileIdentity:'1:9'},
        hasMore:false,pendingTail:false}
    },
    readArchivedNativeHooksPage:async()=>({records:[],hasMore:false}),
  } as unknown as SourceDefinition
  const policy={
    isSourceEnabled:()=>true,isEnabled:()=>true,
    sanitizeNormalizedOutput:(value:unknown)=>value,
  } as unknown as CapturePolicyService
  const scoped=new NativeSessionReader(storage as never,
    {list:()=>[source]} as unknown as SourceService,policy,worker)
  assert.equal((await scoped.read(query)).state,'available')
  assert.equal((await scoped.readArchivedHooks(query)).state,'available')
  assert.equal((await scoped.readUnpersistedMediaPage({
    ...query,cursor:{offset:0,sequence:0,fileIdentity:'1:9'},
  })).state,'drifted') // A valid profile root is necessary but not sufficient to hydrate a record.
  assert.deepEqual(resolvedRoots,['/scoped-sessions','/scoped-sessions','/scoped-sessions'])
  const missingProfile=new NativeSessionReader({
    ...storage,runtimeProfiles:{async get(){return null}},
  } as never,{list:()=>[source]} as unknown as SourceService,policy,worker)
  assert.deepEqual(await missingProfile.read(query),{
    state:'unavailable',reason:'native-runtime-profile-missing',
  })
  assert.deepEqual(await missingProfile.readArchivedHooks(query),{
    state:'unavailable',reason:'native-runtime-profile-missing',
  })
})

test('large native record fragments require Source identity and parent CapturePolicy before returning text',async()=>{
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},hosts:{async get(){return host}}},
  } as unknown as StorageService
  let readCount=0
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(q:{filePath:string;nativeSessionId:string;cursor:{offset:number}},
      ctx:{checkpoint:{set(key:string,value:unknown):Promise<void>}}){
      readCount++
      assert.equal(q.filePath,catalog.filePath)
      assert.equal(q.nativeSessionId,catalog.nativeSessionId)
      assert.equal(q.cursor.offset,70)
      await assert.rejects(ctx.checkpoint.set('cannot-write',123))
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'a'.repeat(64),
        role:'user',
        fragments:[{ordinal:0,text:'sensitive-source-string',kind:'message'}],
        totalTextFragments:1,
      }}
    },
  } as unknown as SourceDefinition
  let sanitized=0
  const policy={
    isSourceEnabled:()=>true,
    capture(_scope:string, text:string){
      sanitized++
      assert.equal(_scope,'prompt')
      assert.equal(text,'sensitive-source-string')
      return {value:'[已脱敏]',mode:'redacted',redactionApplied:true}
    },
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,policy)
  const baseQuery={sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{fileIdentity:'1:9',offset:70,sequence:2},
    signal:new AbortController().signal}
  const result=await reader.readTextFragments(baseQuery)
  assert.equal(result.state,'available')
  if(result.state==='available'){
    assert.deepEqual(result.record.fragments,[
      {ordinal:0,text:'[已脱敏]',kind:'message',redactionApplied:true},
    ])
    assert.equal(JSON.stringify(result).includes('sensitive-source-string'),false)
  }
  assert.equal(readCount,1)
  assert.equal(sanitized,1)
  assert.deepEqual(await reader.readTextFragments({...baseQuery,
    cursor:{...baseQuery.cursor,fileIdentity:'different'}}),{
    state:'drifted',reason:'native-catalog-file-identity-changed',
  })
  assert.equal(readCount,1)
  const disabled=new NativeSessionReader(storage,{list:()=>[source]} as unknown as SourceService,
    {isSourceEnabled:()=>false} as unknown as CapturePolicyService)
  assert.deepEqual(await disabled.readTextFragments(baseQuery),{
    state:'unsupported',reason:'source-disabled',
  })
})

test('large split scalar fragments are masked under redacted CapturePolicy',async()=>{
  const storage={nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  const source={
    manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(){
      return {state:'available' as const,record:{
        offset:0,fileIdentity:'1:9',recordSha256:'a'.repeat(64),
        role:'user',
        fragments:[{ordinal:0,text:'sk-sensitive-long-token-part',kind:'thinking',contentIndex:0,splitScalar:true}],
        totalTextFragments:2,nextFragmentOffset:1,
      }}
    },
  } as unknown as SourceDefinition
  for(const mode of ['redacted','full'] as const){
    let called=false
    const policy={
      isSourceEnabled:()=>true,
      modeFor:()=>mode,
      capture(){called=true;return {value:'unexpected',mode,redactionApplied:false}},
    } as unknown as CapturePolicyService
    const reader=new NativeSessionReader(storage,
      {list:()=>[source]} as unknown as SourceService,policy)
    const value=await reader.readTextFragments({
      ...query,cursor:{offset:0,sequence:0,fileIdentity:'1:9'},
    })
    assert.equal(value.state,'available')
    if(value.state==='available')assert.deepEqual(value.record.fragments,[{
      ordinal:0,text:'[超长文本片段已脱敏]',kind:'thinking',contentIndex:0,
      splitScalar:true,redactionApplied:true,suppressed:true,
    }])
    assert.equal(called,false,`${mode} must not sanitize a partial scalar independently`)
  }
})

test('inline image chunks require enabled prompt capture and validated original identities',async()=>{
  const storage={nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  let calls=0
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(q:{
      media?:{contentIndex:number;offset:number;limit:number}
      expectedSha256?:string
    }){
      calls++
      assert.deepEqual(q.media,{contentIndex:1,offset:0,limit:128*1024})
      assert.equal(q.expectedSha256,'a'.repeat(64))
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'a'.repeat(64),
        role:'user',fragments:[],totalTextFragments:0,
        media:{contentIndex:1,mimeType:'image/png',base64:'AQID',totalBase64Length:4},
      }}
    },
  } as unknown as SourceDefinition
  const enabled=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,{
      isSourceEnabled:()=>true,isEnabled:()=>true,
      modeFor:()=> 'redacted',
    } as unknown as CapturePolicyService)
  const query={sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{fileIdentity:'1:9',offset:70,sequence:2},
    expectedSha256:'a'.repeat(64),signal:new AbortController().signal,
    media:{contentIndex:1,offset:0,limit:128*1024},
  }
  const result=await enabled.readTextFragments(query)
  assert.equal(result.state,'available')
  if(result.state==='available')assert.equal(result.record.media?.base64,'AQID')
  assert.equal(calls,1)
  const disabled=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,{
      isSourceEnabled:()=>true,isEnabled:()=>false,
    } as unknown as CapturePolicyService)
  assert.deepEqual(await disabled.readTextFragments(query),{
    state:'unsupported',reason:'native-attachment-capture-disabled',
  })
  assert.equal(calls,1,'disabled capture never enters the Source adapter')
})

test('native tool argument fragments use key-aware CapturePolicy and hide private field paths',async()=>{
  const storage={nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  const callKey='a'.repeat(64)
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(){
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'b'.repeat(64),
        role:'assistant',totalTextFragments:4,
        fragments:[
          {ordinal:0,text:'plain-secret',kind:'tool-call' as const,
            callKey,fieldKeys:['arguments','credentials','password']},
          {ordinal:1,text:'src/index.ts',kind:'tool-call' as const,
            callKey,fieldKeys:['arguments','path']},
          {ordinal:2,text:'other-secret',kind:'tool-call' as const,
            callKey,fieldKeys:['arguments','items','token']},
          {ordinal:3,text:'untrusted-prototype',kind:'tool-call' as const,
            fieldKeys:['arguments','__proto__']},
        ],
      }}
    },
  } as unknown as SourceDefinition
  const captures:unknown[]=[]
  const policy={
    isSourceEnabled:()=>true,
    modeFor:()=> 'redacted' as const,
    capture(scope:string,input:unknown){
      assert.equal(scope,'tool')
      captures.push(input)
      const value=JSON.stringify(input)
      const isSensitive=value.includes('plain-secret')||value.includes('other-secret')
      if(value.includes('plain-secret'))
        return {value:{arguments:{credentials:'[已脱敏]'}},
          mode:'redacted' as const,redactionApplied:true}
      if(value.includes('other-secret'))
        return {value:{arguments:{items:{token:'[已脱敏]'}}},
          mode:'redacted' as const,redactionApplied:true}
      assert.equal(isSensitive,false)
      return {value:input,mode:'redacted' as const,redactionApplied:false}
    },
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,policy)
  const value=await reader.readTextFragments({
    sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{fileIdentity:'1:9',offset:70,sequence:0},
    signal:new AbortController().signal,
  })
  assert.equal(value.state,'available')
  if(value.state!=='available')return
  assert.deepEqual(captures,[
    {arguments:{credentials:{password:'plain-secret'}}},
    {arguments:{path:'src/index.ts'}},
    {arguments:{items:{token:'other-secret'}}},
  ])
  assert.deepEqual(value.record.fragments.map(x=>x.text),
    ['[已脱敏]','src/index.ts','[已脱敏]','[超长文本片段已脱敏]'])
  assert.equal(value.record.fragments[3]?.suppressed,true)
  assert.equal(JSON.stringify(value).includes('fieldKeys'),false)
  assert.equal(JSON.stringify(value).includes('plain-secret'),false)
  assert.equal(JSON.stringify(value).includes('other-secret'),false)
  assert.equal(value.record.fragments[0]?.callKey,callKey)
  assert.equal(value.record.fragments[3]?.callKey,undefined)
})

test('tool result details use the same key-aware policy as tool call arguments',async()=>{
  const storage={nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(){
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'d'.repeat(64),
        role:'toolResult',totalTextFragments:2,
        fragments:[
          {ordinal:0,kind:'tool-result' as const,text:'raw-value',
            fieldKeys:['details','credentials','token'],valueType:'string' as const},
          {ordinal:1,kind:'tool-result' as const,text:'200',
            fieldKeys:['details','status'],valueType:'number' as const},
        ],
      }}
    },
  } as unknown as SourceDefinition
  const inputs:unknown[]=[]
  const policy={
    isSourceEnabled:()=>true,
    capture(scope:string,value:unknown){
      assert.equal(scope,'tool')
      inputs.push(value)
      if(JSON.stringify(value).includes('raw-value'))
        return {value:{details:{credentials:'[已脱敏]'}},
          mode:'redacted' as const,redactionApplied:true}
      return {value,mode:'redacted' as const,redactionApplied:false}
    },
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,policy)
  const result=await reader.readTextFragments({
    sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{offset:70,sequence:2,fileIdentity:'1:9'},
    signal:new AbortController().signal,
  })
  assert.equal(result.state,'available')
  if(result.state!=='available')return
  assert.deepEqual(inputs,[
    {details:{credentials:{token:'raw-value'}}},
    {details:{status:'200'}},
  ])
  assert.deepEqual(result.record.fragments.map(x=>x.text),['[已脱敏]','200'])
  assert.equal(result.record.fragments[1]?.valueType,'number')
  assert.equal(JSON.stringify(result).includes('fieldKeys'),false)
  assert.equal(JSON.stringify(result).includes('raw-value'),false)
})

test('mixed native assistant record applies prompt/tool capture independently and never discloses disabled media',async()=>{
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  let nativeRole='assistant'
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(){
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'a'.repeat(64),
        role:nativeRole,fragments:[
          {ordinal:0,kind:'message' as const,text:'assistant body'},
          {ordinal:1,kind:'thinking' as const,text:'thought'},
          {ordinal:2,kind:'tool-call' as const,text:'command input',
            fieldKeys:['arguments','command']},
          {ordinal:3,kind:'tool-result' as const,text:'tool output'},
        ],totalTextFragments:4,
        images:[{contentIndex:0,mimeType:'image/png'}],
        imagesTruncated:true,
        media:{contentIndex:0,mimeType:'image/png',base64:'AQID',totalBase64Length:4},
      }}
    },
  } as unknown as SourceDefinition
  const captured:string[]=[]
  let prompt=true
  let tool=false
  const policy={
    isSourceEnabled:()=>true,
    isEnabled:(scope:string)=>scope==='prompt'?prompt:tool,
    capture(scope:string,value:unknown){
      captured.push(scope)
      if(scope==='tool')return {mode:'off' as const,value:null,redactionApplied:true}
      return {mode:'redacted' as const,value,redactionApplied:false}
    },
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,policy)
  const base={
    sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{offset:70,sequence:2,fileIdentity:'1:9'},
    signal:new AbortController().signal,
  }
  const page=await reader.readTextFragments(base)
  assert.equal(page.state,'available')
  if(page.state==='available'){
    assert.deepEqual(page.record.fragments.map(x=>x.text),
      ['assistant body','thought','',''])
    assert.equal(page.record.fragments[2]?.suppressed,true)
    assert.deepEqual(page.record.images,[{contentIndex:0,mimeType:'image/png'}])
  }
  assert.deepEqual(captured,['prompt','prompt','tool','tool'])
  nativeRole='toolResult'
  const rejected=await reader.readTextFragments({...base,
    media:{contentIndex:0,offset:0,limit:128*1024}})
  assert.deepEqual(rejected,{state:'unsupported',
    reason:'native-attachment-capture-disabled'})
  const hidden=await reader.readTextFragments(base)
  assert.equal(hidden.state,'available')
  if(hidden.state==='available'){
    assert.deepEqual(hidden.record.images,[])
    assert.equal(hidden.record.imagesTruncated,undefined)
  }
  tool=true
  const allowed=await reader.readTextFragments({...base,
    media:{contentIndex:0,offset:0,limit:128*1024}})
  assert.equal(allowed.state,'available')
  if(allowed.state==='available')
    assert.equal(allowed.record.media?.base64,'AQID')
})

test('native tool links enforce catalog identity and tool privacy before Source access',async()=>{
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  let calls=0
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async findNativeToolResult(q:{
      filePath:string;cursor:{offset:number};callKey:string
      fragmentOrdinal:number;expectedSha256:string
    }){
      calls++
      assert.equal(q.filePath,catalog.filePath)
      assert.equal(q.cursor.offset,70)
      assert.equal(q.callKey,'c'.repeat(64))
      assert.equal(q.fragmentOrdinal,3)
      assert.equal(q.expectedSha256,'a'.repeat(64))
      return {state:'available' as const,scannedRecords:1,
        match:{cursor:{offset:100,sequence:3,fileIdentity:'1:9',
          recordFingerprint:'d'.repeat(64)},
          recordSha256:'b'.repeat(64)}}
    },
  } as unknown as SourceDefinition
  const query={sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{offset:70,sequence:2,fileIdentity:'1:9'},
    fragmentOrdinal:3,expectedSha256:'a'.repeat(64),callKey:'c'.repeat(64),
    signal:new AbortController().signal,
  }
  const sources={list:()=>[source]} as unknown as SourceService
  const reader=new NativeSessionReader(storage,sources,{
    isSourceEnabled:()=>true,isEnabled:()=>true,
  } as unknown as CapturePolicyService)
  const available=await reader.findNativeToolResult(query)
  assert.equal(available.state,'available')
  if(available.state==='available')
    assert.equal(available.match?.recordSha256,'b'.repeat(64))
  assert.equal(calls,1)
  assert.deepEqual(await reader.findNativeToolResult({...query,
    cursor:{...query.cursor,fileIdentity:'other'}}),{
    state:'drifted',reason:'native-catalog-file-identity-changed'})
  assert.equal(calls,1)
  const off=new NativeSessionReader(storage,sources,{
    isSourceEnabled:()=>true,isEnabled:(scope:string)=>scope!=='tool',
  } as unknown as CapturePolicyService)
  assert.deepEqual(await off.findNativeToolResult(query),{
    state:'unsupported',reason:'native-tool-capture-disabled'})
  assert.equal(calls,1)
})

test('verified native block metadata never bypasses tool and image CapturePolicy',async()=>{
  const storage={
    nativeSessionCatalog:{async get(){return catalog}},
    repositories:{installations:{async get(){return installation}},
      hosts:{async get(){return host}}},
  } as unknown as StorageService
  const source={manifest:{sourceId:'pi',productId:'pi'},
    async readNativeTextFragments(){
      return {state:'available' as const,record:{
        offset:70,fileIdentity:'1:9',recordSha256:'a'.repeat(64),
        role:'assistant',
        fragments:[],totalTextFragments:0,
        images:[{contentIndex:2,mimeType:'image/png'}],
        contentBlocks:[
          {contentIndex:0,kind:'text' as const,fragmentCount:1},
          {contentIndex:1,kind:'tool-call' as const,fragmentCount:0,
            name:'secret-command',callKey:'c'.repeat(64)},
          {contentIndex:2,kind:'image' as const,fragmentCount:0},
        ],
      }}
    },
  } as unknown as SourceDefinition
  let prompt=true
  let tool=false
  let redactToolName=false
  const policy={
    isSourceEnabled:()=>true,
    isEnabled:(scope:string)=>scope==='prompt'?prompt:tool,
    capture(scope:string,value:unknown){
      if(scope==='tool'&&redactToolName)
        return {mode:'redacted' as const,value:'[masked]',redactionApplied:true}
      return {mode:'redacted' as const,value,redactionApplied:false}
    },
  } as unknown as CapturePolicyService
  const reader=new NativeSessionReader(storage,
    {list:()=>[source]} as unknown as SourceService,policy)
  const query={sourceId:'pi',installationId:'install',nativeSessionId:'S1',
    cursor:{offset:70,sequence:2,fileIdentity:'1:9'},
    signal:new AbortController().signal}
  const disabled=await reader.readTextFragments(query)
  assert.equal(disabled.state,'available')
  if(disabled.state==='available'){
    assert.deepEqual(disabled.record.contentBlocks,[
      {contentIndex:0,kind:'text',fragmentCount:1},
      {contentIndex:1,kind:'tool-call',fragmentCount:0,suppressed:true},
      {contentIndex:2,kind:'image',fragmentCount:0},
    ])
    assert.equal(JSON.stringify(disabled.record).includes('secret-command'),false)
    assert.equal(JSON.stringify(disabled.record).includes('c'.repeat(64)),false)
  }
  tool=true
  redactToolName=true
  const redacted=await reader.readTextFragments(query)
  assert.equal(redacted.state,'available')
  if(redacted.state==='available'){
    assert.equal(redacted.record.contentBlocks?.[1]?.name,'[masked]')
    assert.equal(redacted.record.contentBlocks?.[1]?.redactionApplied,true)
    assert.equal(redacted.record.contentBlocks?.[1]?.callKey,'c'.repeat(64))
  }
  prompt=false
  const noMedia=await reader.readTextFragments(query)
  assert.equal(noMedia.state,'available')
  if(noMedia.state==='available'){
    assert.deepEqual(noMedia.record.images,[])
    assert.equal(noMedia.record.contentBlocks?.some(x=>x.kind==='image'),false)
    assert.equal(noMedia.record.contentBlocks?.[0]?.suppressed,true)
  }
})
