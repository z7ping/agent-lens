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
    const second=await fetch(`${base}?sourceId=pi&installationId=installation&limit=2&cursor=${result.nextCursor}`)
    assert.equal(second.status,200)
    assert.deepEqual(seen[1],{
      sourceId:'pi',installationId:'installation',limit:2,
      before:{lastActivityAt:now,sourceId:'codex',installationId:'installation',
        nativeSessionId:'B',locationKind:'native'},
    })
    const filtered=await fetch(`${base}?sourceId=codex`)
    assert.equal(filtered.status,200)
    assert.deepEqual(await filtered.json(),{items:[],hasMore:false})
    assert.equal(seen.length,2)
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
      '?installationId=', '?cursor=not-valid',
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
