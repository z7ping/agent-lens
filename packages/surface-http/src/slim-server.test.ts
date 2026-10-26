import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { startNativeOnlyHttpSurface } from './slim-server'
import { DefaultLiveAttachmentService } from '@agent-lens/core-services'

test('Slim-only HTTP reads native Catalog/facets and refuses all old Event APIs',async()=>{
  let listed=0
  const source={
    manifest:{sourceId:'pi',productId:'pi',parserVersion:'v1',displayName:'Pi'},
    nativeSessionCoverageComplete:true,
  }
  const sources={list:()=>[source]} as unknown as SourceService
  let enabledSources=['pi']
  const policy={
    isSourceEnabled:(sourceId:string)=>enabledSources.includes(sourceId),
    getSourceConfiguration:()=>({
      effectiveEnabledSources:enabledSources,
      configuredEnabledSources:enabledSources,
      source:'fixture',editable:true,restartRequired:false,
    }),
    async setEnabledSources(values:string[]){enabledSources=values},
  } as unknown as CapturePolicyService
  const storage={
    nativeSessionCatalog:{
      async getByReviewSessionId(){return null},
      async get(){return null},
      async query(){throw new Error('Slim handler should prefer session list')},
      async isNativeMetricsEligible(){return true},
    },
    nativeSessionList:{async query(input:{limit:number}){
      listed++
      assert.equal(input.limit,5)
      return {items:[],hasMore:false}
    }},
    nativeFacets:{async query(){
      return {installedProducts:[{productId:'pi',installationIds:['install']}],
        projects:[],projectsTruncated:false}
    }},
    launchableProjects:{
      async query(){
        return {items:[{
          key:'project-1',projectId:'project-1',projectName:'SlowLight',
          lastSeenAt:new Date().toISOString(),
          workspaces:[{
            workspaceId:'workspace-1',workspacePath:'/projects/SlowLight',
            lastSeenAt:new Date().toISOString(),validationStatus:'valid' as const,
            validatedAt:new Date().toISOString(),
          }],
        }],hasMore:false}
      },
      async recordWorkspaceValidation(){},
    },
    nativeSessionMetrics:{
      async get(){return {state:'missing' as const}},
      async replace(){return true},
      async invalidate(){},
      async overview(){return {
        sourceId:'pi',eligibleSessions:0,readySessions:0,missingSessions:0,
        staleSessions:0,partialSessions:0,
        totals:{interactionCount:0,toolCallCount:0,toolResultCount:0,
          toolErrorCount:0,errorCount:0,inputTokens:null,outputTokens:null},
        tools:[],toolsTruncated:false,
      }},
      async findRebuildCandidates(){return []},
    },
    async health(){return {ok:true,schemaVersion:1,
      details:{schemaKind:'slim-native-session-v1'}}},
  }
  const reader={async read(){return {state:'unsupported',reason:'not-indexed'}}}
  const liveAttachments=new DefaultLiveAttachmentService()
  const surface=await startNativeOnlyHttpSurface(storage as never,{
    port:0,sources,reader:reader as never,capturePolicy:policy,
    lives:{list:()=>[]} as never,liveAttachments,
    backup:{async overview(){return {
      vaultPath:'/existing-backup',sources:[],snapshots:[],
    }}} as never,
  })
  const base=`http://${surface.host}:${surface.port}`
  try{
    const backup=await fetch(base+'/api/v1/backups')
    assert.equal(backup.status,200)
    assert.equal((await backup.json() as {vaultPath:string}).vaultPath,'/existing-backup')
    const live=await fetch(base+'/api/v1/live')
    assert.equal(live.status,200)
    assert.deepEqual((await live.json() as {items:unknown[]}).items,[])
    const upload=await fetch(base+'/api/v1/live/attachments',{
      method:'POST',body:new TextEncoder().encode('native-image-bytes'),
      headers:{'content-type':'image/png'},
    })
    assert.equal(upload.status,201)
    const attachmentId=(await upload.json() as {attachmentId:string}).attachmentId
    const attached=await fetch(base+'/api/v1/live/attachments/'+encodeURIComponent(attachmentId))
    assert.equal(attached.status,200)
    assert.equal(await attached.text(),'native-image-bytes')
    const configuration=await fetch(base+'/api/v1/capture-policy/sources')
    assert.equal(configuration.status,200)
    assert.deepEqual((await configuration.json() as {settings:{effectiveEnabledSources:string[]}}).settings.effectiveEnabledSources,['pi'])
    const changed=await fetch(base+'/api/v1/capture-policy/sources',{
      method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({enabledSources:[]}),
    })
    assert.equal(changed.status,200)
    assert.deepEqual((await changed.json() as {settings:{configuredEnabledSources:string[]}}).settings.configuredEnabledSources,[])
    assert.equal((await fetch(base+'/api/v1/capture-policy/sources',{method:'POST'})).status,405)
    enabledSources=['pi']
    const locales=await fetch(base+'/api/v1/locales')
    assert.equal(locales.status,200)
    const localeBody=await locales.json() as {items:unknown[];meta:{protocolVersion:string}}
    assert.deepEqual(localeBody.items,[])
    assert.ok(localeBody.meta.protocolVersion)
    assert.equal((await fetch(base+'/api/v1/locales',{method:'POST'})).status,405)
    const ready=await fetch(base+'/api/v1/ready')
    assert.equal(ready.status,200)
    assert.equal((await ready.json() as {storageMode:string}).storageMode,'native-only')
    const list=await fetch(base+'/api/v1/native-sessions?sourceId=pi&limit=5')
    assert.equal(list.status,200)
    assert.deepEqual((await list.json() as {items:unknown[]}).items,[])
    assert.equal(listed,1)
    const facets=await fetch(base+'/api/v1/facets')
    assert.equal(facets.status,200)
    assert.equal((await facets.json() as {agents:Array<{sourceId:string}>}).agents[0]?.sourceId,'pi')
    const health=await fetch(base+'/api/v1/health')
    assert.equal(health.status,200)
    assert.equal((await health.json() as {storage:{schemaVersion:number}}).storage.schemaVersion,1)
    const projects=await fetch(base+'/api/v1/projects/launchable')
    assert.equal(projects.status,200)
    const projectPage=await projects.json() as {items:Array<{
      key:string;workspaceId:string;workspacePath:string
    }>}
    assert.equal(projectPage.items[0]?.key,'project-1')
    assert.equal(projectPage.items[0]?.workspaceId,'workspace-1')
    assert.equal(projectPage.items[0]?.workspacePath,'/projects/SlowLight')
    const invalid=await fetch(base+'/api/v1/projects/launchable?limit=999')
    assert.equal(invalid.status,400)
    const method=await fetch(base+'/api/v1/projects/launchable',{method:'POST'})
    assert.equal(method.status,405)
    for(const name of ['source-records','timeline','review','sessions','assets']){
      const old=await fetch(base+'/api/v1/'+name)
      assert.equal(old.status,501,name)
      assert.equal((await old.json() as {error:string}).error,
        'native_only_route_not_implemented')
    }
  }finally{await surface.dispose();await liveAttachments.dispose()}
})
