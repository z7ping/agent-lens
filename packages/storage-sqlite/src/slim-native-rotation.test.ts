import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { SqliteSlimStorage } from './slim-storage'

test('native file rotation resets physical revision instead of splicing old timestamps',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const catalog=storage.nativeSessionCatalog
    const base={
      sourceId:'pi',installationId:'install',nativeSessionId:'session',
      locationKind:'native' as const,filePath:resolve('original.jsonl'),
      fileIdentity:'1:1',fileSize:400,fileMtimeMs:200,
      lastActivityAt:'2026-10-26T10:00:00Z',updatedAt:'2026-10-26T10:01:00Z',
    }
    await catalog.upsert(base)
    await catalog.upsert({...base,filePath:resolve('replacement.jsonl'),
      fileIdentity:'2:2',fileSize:100,fileMtimeMs:100,
      lastActivityAt:'2026-10-26T08:00:00Z'})
    const value=await catalog.get({
      sourceId:'pi',installationId:'install',nativeSessionId:'session',
    })
    assert.equal(value?.fileIdentity,'2:2')
    assert.equal(value?.fileSize,100)
    assert.equal(value?.fileMtimeMs,100)
    assert.equal(value?.lastActivityAt,'2026-10-26T08:00:00Z')
  }finally{await storage.close()}
})
