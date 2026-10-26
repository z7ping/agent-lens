import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StorageService, SourceService, CapturePolicyService,
} from '@agent-lens/core'
import { startHttpSurface } from './server'

test('Facets HTTP consumes slim metadata and never queries Legacy observation/session projections',async()=>{
  let called=0
  const storage={
    async health(){return {ok:true}},
    nativeFacets:{
      async query(){
        called++
        return {
          installedProducts:[{productId:'pi',installationIds:['install']}],
          projects:[{id:'p',name:'A project',lastActivityAt:'2026-10-26T10:00:00Z'}],
          projectsTruncated:false,
        }
      },
    },
    repositories:new Proxy({},{
      get(){throw new Error('Legacy RepositorySet must not be queried by native Facets')}
    }),
  } as unknown as StorageService
  const sources={
    list:()=>[{
      manifest:{sourceId:'pi',productId:'pi',displayName:'Pi'},
    }],
  } as unknown as SourceService
  const policy={isSourceEnabled:()=>true} as unknown as CapturePolicyService
  const server=await startHttpSurface(storage,{port:0,sources,capturePolicy:policy})
  try{
    const response=await fetch(`http://${server.host}:${server.port}/api/v1/facets`)
    assert.equal(response.status,200)
    const json=await response.json() as {
      agents:Array<{sourceId:string;detected:boolean;installationIds:string[]}>
      projects:Array<{id:string;name:string}>
      dateRange:Record<string,unknown>
      meta:{native:{projectsTruncated:boolean;dateRangeState:string}}
    }
    assert.equal(called,1)
    assert.deepEqual(json.agents[0]?.installationIds,['install'])
    assert.equal(json.agents[0]?.detected,true)
    assert.deepEqual(json.projects.map(x=>x.id),['p'])
    assert.deepEqual(json.dateRange,{})
    assert.equal(json.meta.native.dateRangeState,'unavailable')
    assert.equal(json.meta.native.projectsTruncated,false)
    assert.equal(JSON.stringify(json).includes('filePath'),false)
  }finally{await server.dispose()}
})
