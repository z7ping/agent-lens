import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalVault } from '@agent-lens/backup-local'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import type { SourceDefinition, SourceService } from '@agent-lens/core'

test('Slim Vault preserves existing snapshot/verify behavior without a Legacy event database',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-slim-vault-'))
  const dataRoot=join(root,'original-agent','sessions')
  const vaultPath=join(root,'vault')
  const native=join(dataRoot,'original.jsonl')
  let storage:SqliteSlimStorage|undefined
  try {
    await mkdir(dataRoot,{recursive:true})
    await writeFile(native,'{"type":"session","id":"a"}\n','utf8')
    storage=await SqliteSlimStorage.createFresh(join(root,'slim.sqlite'))
    const source:SourceDefinition={
      manifest:{
        pluginId:'@test/slim-vault',pluginVersion:'1.0.0',apiVersion:'1.0',
        pluginType:'source',displayName:'Vault Source',
        sourceId:'vault-test',productId:'vault-test',parserVersion:'1',
      },
      async detect(){
        return [{sourceId:'vault-test',productId:'vault-test',
          dataRoot,confidence:'exact'}]
      },
      async declareCapabilities(){return []},
      async normalize(){return {observations:[],evidenceCandidates:[]}},
    }
    const sources={list:()=>[source]} as unknown as SourceService
    const local=startLocalVault(storage,sources,storage.identity,{
      vaultPath,sourceOrder:['vault-test'],
    })
    try{
      const index=await local.service.refreshIndex!({sourceIds:['vault-test']})
      assert.ok(index.sources.some(item=>item.fileCount>=1))
      const snapshot=await local.service.createSnapshot({sourceIds:['vault-test'],kinds:['session']})
      assert.ok(snapshot.files.some(file=>file.kinds.includes('session')))
      assert.equal((await local.service.verifySnapshot(snapshot.id)).valid,true)
      assert.equal(await readFile(native,'utf8'),'{"type":"session","id":"a"}\n')
      const oldTables=storage.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('source_records','observations','evidence','logical_sessions')
      `).all()
      assert.deepEqual(oldTables,[],'backup must not require the old event schema')
    } finally {
      local.stop()
    }
  }finally{
    await storage?.close()
    await rm(root,{recursive:true,force:true})
  }
})
