import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePolicyService, NativeSessionCatalogEntry, NativeSessionCatalogQuery, NativeSessionCatalogStore, StorageService } from '@agent-lens/core'
import { nativeReviewSessionId } from '@agent-lens/projection-review'
import { startHttpSurface } from './server'

const now = '2026-10-25T00:00:00Z'
const entry = (id: string, sourceId = 'pi'): NativeSessionCatalogEntry => ({
  sourceId, installationId: 'installation', nativeSessionId: id,
  locationKind: 'native', filePath: `/private/native/${id}.jsonl`,
  fileIdentity: '5:22', fileSize: 64, fileMtimeMs: 1,
  lastActivityAt: now, updatedAt: now, title: `Session ${id}`,
})

test('native Catalog HTTP exposes only authorized session identities, no physical storage paths', async () => {
  const seen: NativeSessionCatalogQuery[] = []
  const all = [entry('A'), entry('B','codex'), entry('C')]
  const catalog = {
    async query(query: NativeSessionCatalogQuery = {}) {
      seen.push(query)
      return { items: all.slice(0,2), hasMore: true }
    },
    async getByReviewSessionId(id: string) {
      return id === nativeReviewSessionId('pi','installation','A') ? all[0]! : null
    },
  } as NativeSessionCatalogStore
  const policy = {
    isSourceEnabled: (id: string) => id === 'pi',
  } as unknown as CapturePolicyService
  const storage = {
    nativeSessionCatalog: catalog,
    async health() { return { ok: true } },
  } as unknown as StorageService
  const http = await startHttpSurface(storage, { port: 0, capturePolicy: policy })
  const base = `http://${http.host}:${http.port}/api/v1/native-sessions`
  try {
    const first = await fetch(`${base}?limit=2`)
    assert.equal(first.status,200)
    const result = await first.json() as { items: Array<Record<string,unknown>>; nextCursor: string; hasMore: boolean }
    assert.deepEqual(result.items, [{
      id: nativeReviewSessionId('pi', 'installation', 'A'),
      sourceId: 'pi',installationId: 'installation',nativeSessionId: 'A',
      locationKind: 'native',lastActivityAt: now,title:'Session A',
    }])
    assert.equal(result.items[0]?.id, nativeReviewSessionId('pi','installation','A'))
    assert.equal(JSON.stringify(result).includes('/private/native'), false)
    assert.equal(result.items[0]?.id?.startsWith('native:'),true)
    assert.equal(result.hasMore,true)
    assert.equal(JSON.stringify(result).includes('/private/native'), false)
    assert.equal(JSON.stringify(result).includes('fileIdentity'), false)
    const direct = await fetch(`${base}/${encodeURIComponent(nativeReviewSessionId('pi','installation','A'))}`)
    assert.equal(direct.status,200)
    assert.deepEqual(await direct.json(),result.items[0])
    assert.equal((await fetch(`${base}/${encodeURIComponent(nativeReviewSessionId('pi','installation','missing'))}`)).status,404)
    // Direct-link lookup is indexed and never executes Catalog.query().
    assert.equal(seen.length,1)
    const second=await fetch(`${base}?sourceId=pi&installationId=installation&limit=2&cursor=${result.nextCursor}`)
    assert.equal(second.status,200)
    assert.deepEqual(seen[1],{
      sourceId:'pi',installationId:'installation',limit:2,
      before:{lastActivityAt:now,sourceId:'codex',installationId:'installation',
        nativeSessionId:'B',locationKind:'native'},
    })
    const metadataSearch = await fetch(`${base}?search=title&limit=2`)
    assert.equal(metadataSearch.status,200)
    assert.equal(seen[2]?.search,'title')
    const onlyNative = await fetch(`${base}?onlyWithoutLegacyReview=1&limit=2`)
    assert.equal(onlyNative.status,200)
    assert.equal(seen[3]?.onlyWithoutLegacyReview,true)
    const project=await fetch(`${base}?projectId=project-123&limit=2`)
    assert.equal(project.status,200)
    assert.equal(seen[4]?.projectId,'project-123')
    assert.equal(JSON.stringify(await project.json()).includes('/private/native'),false)
    const filtered=await fetch(`${base}?sourceId=codex`)
    assert.equal(filtered.status,200)
    assert.deepEqual(await filtered.json(),{items:[],hasMore:false})
    assert.equal(seen.length,5)
  } finally { await http.dispose() }
})

test('native Catalog HTTP rejects invalid cursors and parameters before accessing SQLite', async()=>{
  let queries=0
  const catalog = {
    async query(){ queries++; return {items:[],hasMore:false} },
  } as unknown as NativeSessionCatalogStore
  const policy = { isSourceEnabled:()=>true } as unknown as CapturePolicyService
  const storage = { nativeSessionCatalog:catalog, health:async()=>({ok:true}) } as unknown as StorageService
  const http=await startHttpSurface(storage,{port:0,capturePolicy:policy})
  const base=`http://${http.host}:${http.port}/api/v1/native-sessions`
  try{
    for(const suffix of ['?limit=0','?limit=101','?limit=abc','?sourceId=pi&sourceId=codex',
      '?installationId=', '?projectId=', '?projectId=p&projectId=q', '?cursor=not-valid', '?onlyWithoutLegacyReview=0', '?onlyWithoutLegacyReview=2', '?onlyWithoutLegacyReview=1&onlyWithoutLegacyReview=1',
      '?cursor='+Buffer.from(JSON.stringify(['x','y','z'])).toString('base64url')]){
      const response=await fetch(base+suffix)
      assert.equal(response.status,400,suffix)
    }
    const post=await fetch(base,{method:'POST'})
    assert.equal(post.status,405)
    assert.equal(queries,0)
  }finally{await http.dispose()}
  const missing=await startHttpSurface({health:async()=>({ok:true})} as unknown as StorageService,{port:0})
  try{
    const response=await fetch(`http://${missing.host}:${missing.port}/api/v1/native-sessions`)
    assert.equal(response.status,503)
  }finally{await missing.dispose()}
})

test('native Catalog HTTP routes slim session listing through coverage-aware metadata model',async()=>{
  const calls:Array<Record<string,unknown>>=[]
  const storage={
    nativeSessionCatalog:{
      async query(){throw new Error('Legacy Catalog query must not be used for slim listing')},
    },
    nativeSessionList:{
      async query(query:Record<string,unknown>){
        calls.push(query)
        return {items:[{
          sourceId:'pi',installationId:'install',nativeSessionId:'s',
          reviewSessionId:nativeReviewSessionId('pi','install','s'),
          lastActivityAt:now,title:'Native title',titleProvenance:'native',
          metricsState:'partial',
          metrics:{interactionCount:2,toolCallCount:1,toolResultCount:1,
            toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null},
        }],hasMore:false}
      },
    },
    async health(){return {ok:true}},
  } as unknown as StorageService
  const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
  const sources={list(){return [{manifest:{sourceId:'pi',parserVersion:'v1'},
    nativeSessionCoverageComplete:false}]}}
  const http=await startHttpSurface(storage,{port:0,capturePolicy:policy,
    sources:sources as never})
  try{
    const res=await fetch(`http://${http.host}:${http.port}/api/v1/native-sessions?sourceId=pi&projectId=project-1`)
    assert.equal(res.status,200)
    const body=await res.json() as {items:Array<Record<string,unknown>>}
    assert.equal(calls.length,1)
    assert.equal(calls[0]?.projectId,'project-1')
    assert.equal(calls[0]?.parserVersion,'v1')
    assert.equal(calls[0]?.coverageCertified,false)
    assert.equal(body.items[0]?.metricsState,'partial')
    assert.equal(body.items[0]?.titleProvenance,'native')
    const unfiltered=await fetch(`http://${http.host}:${http.port}/api/v1/native-sessions`)
    assert.equal(unfiltered.status,200)
    assert.deepEqual(calls[1]?.sourceCertifications,[{
      sourceId:'pi',parserVersion:'v1',coverageCertified:false,
    }])
    assert.equal(JSON.stringify(body).includes('filePath'),false)
  } finally {await http.dispose()}
})
