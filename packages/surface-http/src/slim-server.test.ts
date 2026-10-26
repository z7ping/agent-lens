import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { startNativeOnlyHttpSurface } from './slim-server'
import { DefaultLiveAttachmentService } from '@agent-lens/core-services'
import { previewLocalHostTextFile } from './host-file-preview'

test('Slim-only HTTP reads native Catalog/facets and refuses all old Event APIs',async()=>{
  let listed=0
  const agentRoot=await mkdtemp(join(tmpdir(),'al-slim-agent-files-'))
  await mkdir(join(agentRoot,'config'),{recursive:true})
  await mkdir(join(agentRoot,'data'),{recursive:true})
  await writeFile(join(agentRoot,'config','AGENTS.md'),'# Pi config\n')
  await writeFile(join(agentRoot,'config','.env'),'SECRET=hidden\n')
  await writeFile(join(agentRoot,'data','session.jsonl'),'{"type":"session"}\n')
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
      async getByReviewSessionId(id:string){
        if(id==='native:0123456789abcdef0123456789abcdef')return {
          sourceId:'pi',installationId:'install',nativeSessionId:'native-live-1',
          locationKind:'native',
        }
        return id==='native:ffffffffffffffffffffffffffffffff'
          ?{sourceId:'pi',installationId:'install',nativeSessionId:'native-file-1',
            locationKind:'native'}:null
      },
      async get(){return null},
      async query(){throw new Error('Slim handler should prefer session list')},
      async isNativeMetricsEligible(){return true},
    },
    nativeSessionList:{async query(input:{limit:number;search?:string;sourceId?:string}){
      if(input.search){
        assert.equal(input.search,'native-live-1')
        assert.equal(input.sourceId,'pi')
        assert.equal(input.limit,100)
        return {items:[{
          sourceId:'pi',installationId:'install',nativeSessionId:'native-live-1',
          reviewSessionId:'native:0123456789abcdef0123456789abcdef',
          workspacePath:'/projects/SlowLight',projectId:'project-1',projectName:'SlowLight',
          lastActivityAt:'2026-10-25T10:00:00.000Z',
          metricsState:'missing',titleProvenance:'unknown',
        }],hasMore:false}
      }
      listed++
      assert.equal(input.limit,5)
      return {items:[],hasMore:false}
    }},
    nativeFacets:{async query(){
      return {installedProducts:[{productId:'pi',installationIds:['install']}],
        projects:[],projectsTruncated:false}
    }},
    installations:{async get(id:string){
      if(id!=='install')return null
      return {id:'install',hostId:'host',productId:'pi',
        configRoot:join(agentRoot,'config'),dataRoot:join(agentRoot,'data')}
    }},
    assetInventory:{async listByInstallation(id:string){
      assert.equal(id,'install')
      return [{
        definition:{id:'asset-1',type:'skill',canonicalName:'pi-agent'},
        binding:{id:'binding-1',assetId:'asset-1',installationId:'install',
          path:join(agentRoot,'config')},
        states:[],
      }]
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
      async overview(query?:{nativeToolName?:string}){return {
        sourceId:'pi',eligibleSessions:1,readySessions:1,missingSessions:0,
        staleSessions:0,partialSessions:0,
        totals:{interactionCount:2,toolCallCount:3,toolResultCount:2,
          toolErrorCount:1,errorCount:1,inputTokens:null,outputTokens:null},
        tools:!query?.nativeToolName||query.nativeToolName==='shell'?[{
          nativeToolName:'shell',callCount:3,resultCount:2,errorCount:1,
          totalDurationMs:0,sessionCount:1,
        }]:[],toolsTruncated:false,
      }},
      async findRebuildCandidates(){return []},
    },
    async health(){return {ok:true,schemaVersion:1,
      details:{schemaKind:'slim-native-session-v1'}}},
  }
  const reader={async read(query:{nativeSessionId:string}){
    if(query.nativeSessionId==='native-file-1'||query.nativeSessionId==='native-live-1')return {
      state:'available',observations:[],observationRecordIds:[],evidenceCandidates:[],
      hasMore:false,pendingTail:false,
      nextCursor:{fileIdentity:'file-1',offset:0},
    }
    return {state:'unsupported',reason:'not-indexed'}
  }}
  const liveAttachments=new DefaultLiveAttachmentService()
  const liveAdapter={
    manifest:{liveId:'pi-live',productId:'pi',displayName:'Pi'},
    capabilities:new Set(['create','stream']),
    availability:async()=>({available:true}),
    list:async()=>[{
      runtimeSessionId:'live-1',nativeSessionId:'native-live-1',
      workspacePath:'/projects/SlowLight',status:'ready',
      isStreaming:false,pendingMessageCount:0,
    }],
  }
  const preferences={
    onboarding:{completed:false},displayOrder:['pi'],
    displayOrderConfigured:false,acknowledgedIntegrationIds:[],updatedAt:'2026-10-26T00:00:00Z',
  }
  const surface=await startNativeOnlyHttpSurface(storage as never,{
    port:0,sources,reader:reader as never,capturePolicy:policy,
    openHostPath:async path=>{
      assert.equal(path,join(agentRoot,'config','AGENTS.md'))
      return 'revealed' as const
    },
    previewHostFile:previewLocalHostTextFile,
    rescanAgents:async sourceId=>({status:'completed' as const,
      startedAt:'2026-10-26T00:00:00Z',completedAt:'2026-10-26T00:00:01Z',
      sourcesDetected:sourceId==='pi'?1:1,assetSourcesScanned:1,
      assetsDiscovered:2,assetsRemoved:0,statesRecorded:1,statesCleared:0,failures:[]}),
    backgroundProgress:()=>({examinedScopes:2,indexedSessions:14,runningCaptures:1,
      failedScopes:0,deferredScopes:1,finished:true}),
    integrationDiscovery:{
      snapshot:()=>({status:'idle',items:[],generatedAt:'2026-10-26T00:00:00Z'}),
      async rescan(){return {status:'complete' as const,items:[],generatedAt:'2026-10-26T00:00:00Z'}},
    },
    integrationManagement:{
      async query(){return {items:[],discovery:{status:'idle' as const,generatedAt:'2026-10-26T00:00:00Z'},preferences}},
      preferences:()=>preferences,
      async updatePreferences(){return preferences},
      enabled:()=>({configured:true,effective:true,editable:true,managedBy:'file' as const,restartRequired:false}),
      async setEnabled(){return {configured:false,effective:true,editable:true,managedBy:'file' as const,restartRequired:true}},
    },
    integrationPackages:{
      catalog:()=>[{integrationId:'pi',productId:'pi',displayName:'Pi',
        packageName:'@agent-lens/integration-pi',apiVersion:'1.0',source:'bundled' as const}],
      states:()=>[{integrationId:'pi',installed:false,compatibility:'unknown' as const,
        integrity:'unknown' as const,restartRequired:false}],
      state:id=>id==='pi'?{integrationId:'pi',installed:false,
        compatibility:'unknown' as const,integrity:'unknown' as const,
        restartRequired:false}:null,
      install:async id=>({operationId:'operation-1',integrationId:id,
        kind:'install' as const,status:'completed' as const,startedAt:'2026-10-26T00:00:00Z'}),
      update:async id=>({operationId:'operation-2',integrationId:id,
        kind:'update' as const,status:'completed' as const,startedAt:'2026-10-26T00:00:00Z'}),
      remove:async id=>({operationId:'operation-3',integrationId:id,
        kind:'remove' as const,status:'completed' as const,startedAt:'2026-10-26T00:00:00Z'}),
      operation:id=>id==='operation-1'?{
        operationId:id,integrationId:'pi',kind:'install' as const,status:'completed' as const,
        startedAt:'2026-10-26T00:00:00Z'}:null,
    },
    integrationAuthorization:{
      available:()=>['live' as const],
      async grant(){return ['live' as const]},
    },
    integrationPackages:{
      catalog:()=>[{integrationId:'pi',productId:'pi',displayName:'Pi',
        packageName:'@agent-lens/integration-pi',apiVersion:'1.0',source:'bundled'}],
      states:()=>[{integrationId:'pi',installed:false,compatibility:'compatible',
        integrity:'missing',restartRequired:false}],
      state:id=>id==='pi'?{integrationId:'pi',installed:false,
        compatibility:'compatible',integrity:'missing',restartRequired:false}:null,
      async install(id){return {operationId:'op1',integrationId:id,kind:'install',
        status:'completed',startedAt:'2026-10-26T00:00:00.000Z'}},
      async update(id){return {operationId:'op2',integrationId:id,kind:'update',
        status:'completed',startedAt:'2026-10-26T00:00:00.000Z'}},
      async remove(id){return {operationId:'op3',integrationId:id,kind:'remove',
        status:'completed',startedAt:'2026-10-26T00:00:00.000Z'}},
      operation:id=>id==='op1'?{operationId:'op1',integrationId:'pi',kind:'install',
        status:'completed',startedAt:'2026-10-26T00:00:00.000Z'}:null,
    } as never,
    lives:{list:()=>[liveAdapter]} as never,liveAttachments,
    piEcosystem:{
      async search(value={}){return {query:value.query??'',sort:'downloads' as const,
        items:[],upstreamTotal:0,source:'pi-dev' as const,stale:false,
        fetchedAt:'2026-10-26T00:00:00.000Z',meta:{protocolVersion:'1.0' as const}}},
    },
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
    assert.equal((await live.json() as {items:unknown[]}).items.length,1)
    const runtimeList=await fetch(base+'/api/v1/live/runtimes')
    assert.equal(runtimeList.status,200)
    const runtimeBody=await runtimeList.json() as {items:Array<{
      historySessionId?:string;projectId?:string
    }>}
    assert.equal(runtimeBody.items[0]?.historySessionId,
      'native:0123456789abcdef0123456789abcdef')
    assert.equal(runtimeBody.items[0]?.projectId,'project-1')
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
    const catalog=await fetch(base+'/api/v1/integrations/pi/ecosystem?query=agent')
    assert.equal(catalog.status,200)
    assert.equal((await catalog.json() as {query:string}).query,'agent')
    enabledSources=[]
    const hiddenCatalog=await fetch(base+'/api/v1/integrations/pi/ecosystem')
    assert.equal(hiddenCatalog.status,503)
    enabledSources=['pi']
    const locales=await fetch(base+'/api/v1/locales')
    assert.equal(locales.status,200)
    const localeBody=await locales.json() as {items:unknown[];meta:{protocolVersion:string}}
    assert.deepEqual(localeBody.items,[])
    assert.ok(localeBody.meta.protocolVersion)
    assert.equal((await fetch(base+'/api/v1/locales',{method:'POST'})).status,405)
    const packageCatalog=await fetch(base+'/api/v1/integrations/catalog')
    assert.equal(packageCatalog.status,200)
    assert.equal((await packageCatalog.json() as {catalog:Array<{integrationId:string}>})
      .catalog[0]?.integrationId,'pi')
    assert.equal((await fetch(base+'/api/v1/integrations/unknown/package')).status,404)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/package')).status,200)
    const installed=await fetch(base+'/api/v1/integrations/pi/install',{method:'POST'})
    assert.equal(installed.status,200)
    assert.equal((await installed.json() as {operation:{integrationId:string}})
      .operation.integrationId,'pi')
    assert.equal((await fetch(base+'/api/v1/integration-operations/operation-1')).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/update',{method:'POST'})).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi',{method:'DELETE'})).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/install',{method:'GET'})).status,405)
    const integrationList=await fetch(base+'/api/v1/integrations')
    assert.equal(integrationList.status,200)
    const integrationPrefs=await fetch(base+'/api/v1/integrations/preferences')
    assert.equal(integrationPrefs.status,200)
    assert.equal((await integrationPrefs.json() as {preferences:{displayOrder:string[]}})
      .preferences.displayOrder[0],'pi')
    const packageCatalog=await fetch(base+'/api/v1/integrations/catalog')
    assert.equal(packageCatalog.status,200)
    assert.equal((await packageCatalog.json() as {catalog:unknown[]}).catalog.length,1)
    const installed=await fetch(base+'/api/v1/integrations/pi/install',{method:'POST'})
    assert.equal(installed.status,200)
    assert.equal((await installed.json() as {operation:{kind:string}}).operation.kind,'install')
    assert.equal((await fetch(base+'/api/v1/integration-operations/op1')).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/update',{method:'POST'})).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi',{method:'DELETE'})).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/package')).status,200)
    assert.equal((await fetch(base+'/api/v1/integrations/pi/install')).status,405)
    assert.equal((await fetch(base+'/api/v1/integrations/unknown/install',{method:'POST'})).status,404)
    const discovery=await fetch(base+'/api/v1/integrations/discovery')
    assert.equal(discovery.status,200)
    const auth=await fetch(base+'/api/v1/integrations/pi/authorization',{
      method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({capabilities:['live']}),
    })
    assert.equal(auth.status,200)
    assert.equal((await auth.json() as {restartRequired:boolean}).restartRequired,true)
    assert.equal((await fetch(base+'/api/v1/integrations',{method:'POST'})).status,405)
    const agentFiles=await fetch(
      base+'/api/v1/agents/pi/files?installationId=install&root=config')
    assert.equal(agentFiles.status,200)
    const preview=await fetch(
      base+'/api/v1/agents/pi/file?installationId=install&root=config&path=AGENTS.md')
    assert.equal(preview.status,200)
    assert.equal((await preview.json() as {content:string}).content,'# Pi config\n')
    const sensitive=await fetch(
      base+'/api/v1/agents/pi/file?installationId=install&root=config&path=.env')
    assert.equal(sensitive.status,403)
    const original=await fetch(
      base+'/api/v1/agents/pi/file?installationId=install&root=data&path=session.jsonl')
    assert.equal(original.status,415)
    const outside=await fetch(
      base+'/api/v1/agents/pi/file?installationId=install&root=config&path=../secret.txt')
    assert.equal(outside.status,400)
    const wrong=await fetch(
      base+'/api/v1/agents/pi/files?installationId=other&root=config')
    assert.equal(wrong.status,404)
    const assetDir=await fetch(base+
      '/api/v1/integrations/pi/assets/files?installationId=install&root=config')
    assert.equal(assetDir.status,200)
    const assetPreview=await fetch(base+
      '/api/v1/integrations/pi/assets/file?installationId=install&root=config&path=AGENTS.md')
    assert.equal(assetPreview.status,200)
    assert.equal((await assetPreview.json() as {content:string}).content,'# Pi config' + String.fromCharCode(10))
    const assetBinding=await fetch(base+
      '/api/v1/integrations/pi/assets/files?installationId=install&root=binding&bindingId=binding-1')
    assert.equal(assetBinding.status,200)
    const assetSecret=await fetch(base+
      '/api/v1/integrations/pi/assets/file?installationId=install&root=config&path=.env')
    assert.equal(assetSecret.status,200)
    assert.equal((await assetSecret.json() as {previewStatus:string}).previewStatus,'metadata-only')
    const otherAgent=await fetch(base+
      '/api/v1/integrations/unknown/assets/files?installationId=install&root=config')
    assert.equal(otherAgent.status,404)
    enabledSources=[]
    const disabledAsset=await fetch(base+
      '/api/v1/integrations/pi/assets/files?installationId=install&root=config')
    assert.equal(disabledAsset.status,503)
    enabledSources=['pi']
    assert.equal((await fetch(base+'/api/v1/events',{method:'POST'})).status,405)
    const progress=await fetch(base+'/api/v1/background-activity')
    assert.equal(progress.status,200)
    const progressBody=await progress.json() as {active:unknown[];recent:Array<{state:string}>}
    assert.equal(progressBody.active.length,0)
    assert.equal(progressBody.recent[0]?.state,'degraded')
    const streamController=new AbortController()
    const stream=await fetch(base+'/api/v1/events',{signal:streamController.signal})
    assert.equal(stream.status,200)
    assert.match(stream.headers.get('content-type')??'',/text\/event-stream/)
    streamController.abort()
    const liveFileResponse=await fetch(base+'/api/v1/task-file-changes/runtime/live-1')
    assert.equal(liveFileResponse.status,200)
    assert.equal((await liveFileResponse.json() as {summary:{count:number}})
      .summary.count,0)
    assert.equal((await fetch(base+'/api/v1/task-file-changes/runtime/unknown')).status,404)
    const nativeFileId='native:ffffffffffffffffffffffffffffffff'
    const nativeFileChanges=await fetch(base+'/api/v1/review/'+nativeFileId+'/file-changes')
    assert.equal(nativeFileChanges.status,200)
    const changeBody=await nativeFileChanges.json() as {
      items:unknown[];summary:{count:number};meta:{truncated?:boolean}
    }
    assert.equal(changeBody.summary.count,0)
    assert.equal(changeBody.items.length,0)
    assert.notEqual(changeBody.meta.truncated,true)
    const noExactDiff=await fetch(base+
      '/api/v1/review/'+nativeFileId+'/file-diff?path=src/main.ts')
    assert.equal(noExactDiff.status,200)
    assert.deepEqual(await noExactDiff.json(),{
      path:'src/main.ts',available:false,reason:'not-exact',
    })
    assert.equal((await fetch(base+'/api/v1/review/'+nativeFileId+'/file-diff')).status,400)
    enabledSources=[]
    assert.equal((await fetch(base+
      '/api/v1/review/'+nativeFileId+'/file-changes')).status,404)
    enabledSources=['pi']
    const previewHost=await fetch(base+'/api/v1/host/file-preview',{
      method:'POST',
      headers:{'x-agentlens-host-file-preview-path':
        encodeURIComponent(join(agentRoot,'config','AGENTS.md'))},
    })
    assert.equal(previewHost.status,200)
    assert.equal((await previewHost.json() as {previewStatus:string}).previewStatus,'readable')
    const sensitiveHost=await fetch(base+'/api/v1/host/file-preview',{
      method:'POST',
      headers:{'x-agentlens-host-file-preview-path':
        encodeURIComponent(join(agentRoot,'config','.env'))},
    })
    assert.equal(sensitiveHost.status,200)
    assert.equal((await sensitiveHost.json() as {previewStatus:string}).previewStatus,'metadata-only')
    const opened=await fetch(base+'/api/v1/host/open-path',{
      method:'POST',
      headers:{'x-agentlens-host-open-path-path':
        encodeURIComponent(join(agentRoot,'config','AGENTS.md'))},
    })
    assert.equal(opened.status,200)
    assert.equal((await opened.json() as {action:string}).action,'revealed')
    assert.equal((await fetch(base+'/api/v1/host/file-preview')).status,405)
    const ready=await fetch(base+'/api/v1/ready')
    assert.equal(ready.status,200)
    assert.equal((await ready.json() as {storageMode:string}).storageMode,'native-only')
    const list=await fetch(base+'/api/v1/native-sessions?sourceId=pi&limit=5')
    assert.equal(list.status,200)
    assert.deepEqual((await list.json() as {items:unknown[]}).items,[])
    assert.equal(listed,1)
    const summary=await fetch(base+'/api/v1/agents/summary')
    assert.equal(summary.status,200)
    const data=await summary.json() as {items:Array<{
      sourceId:string;detected:boolean;installationCount:number;
      installationIds:string[];enabled:boolean
    }>}
    assert.deepEqual(data.items.map(x=>x.sourceId),['pi'])
    assert.equal(data.items[0]?.detected,true)
    assert.equal(data.items[0]?.installationCount,1)
    assert.deepEqual(data.items[0]?.installationIds,['install'])
    const summaryPost=await fetch(base+'/api/v1/agents/summary',{method:'POST'})
    assert.equal(summaryPost.status,405)
    const rescanned=await fetch(base+'/api/v1/agents/rescan?sourceId=pi',{method:'POST'})
    assert.equal(rescanned.status,200)
    const scanBody=await rescanned.json() as {status:string;assetsDiscovered:number;
      agents:{items:unknown[]};facets:{agents:unknown[]}}
    assert.equal(scanBody.status,'completed')
    assert.equal(scanBody.assetsDiscovered,2)
    assert.ok(scanBody.agents.items.length>0)
    assert.ok(scanBody.facets.agents.length>0)
    assert.equal((await fetch(base+'/api/v1/agents/rescan?sourceId=unknown',
      {method:'POST'})).status,404)
    assert.equal((await fetch(base+'/api/v1/agents/rescan',{method:'GET'})).status,405)
    const agents=await fetch(base+'/api/v1/agents')
    assert.equal(agents.status,200)
    const agentsView=await agents.json() as {items:Array<{
      sourceId:string;assetInventory:Array<{canonicalName:string;bindings:unknown[]}>
    }>;meta:{native:{usedAssets:string}}}
    assert.equal(agentsView.items[0]?.sourceId,'pi')
    assert.equal(agentsView.items[0]?.assetInventory[0]?.canonicalName,'pi-agent')
    assert.equal(agentsView.items[0]?.assetInventory[0]?.bindings.length,1)
    assert.equal(agentsView.meta.native.usedAssets,'unavailable')
    assert.equal((agentsView.items[0] as {usedAssetsStatus?:string}).usedAssetsStatus,'unavailable')
    const agentDetail=await fetch(base+'/api/v1/agents/pi')
    assert.equal(agentDetail.status,200)
    assert.equal((await agentDetail.json() as {item:{assetInventory:unknown[]}})
      .item.assetInventory.length,1)
    assert.equal((await fetch(base+'/api/v1/agents/unknown')).status,404)
    assert.equal((await fetch(base+'/api/v1/agents/coverage')).status,200)
    assert.equal((await fetch(base+'/api/v1/agents/pi/enrichment')).status,200)
    assert.equal((await fetch(base+'/api/v1/agents',{method:'POST'})).status,405)
    const exactTool=await fetch(base+'/api/v1/usage/detail?toolName=shell&sourceId=pi')
    assert.equal(exactTool.status,200)
    const exactToolBody=await exactTool.json() as {meta:{mode:string;native:{state:string;
      toolCallCount:number;tools:Array<{nativeToolName:string;callCount:number}>}}}
    assert.equal(exactToolBody.meta.mode,'native-only')
    assert.equal(exactToolBody.meta.native.state,'available')
    assert.equal(exactToolBody.meta.native.toolCallCount,3)
    assert.deepEqual(exactToolBody.meta.native.tools.map(item=>item.nativeToolName),['shell'])
    assert.equal((await fetch(base+'/api/v1/usage/detail')).status,400)
    assert.equal((await fetch(base+'/api/v1/usage/detail?toolName=shell',
      {method:'POST'})).status,405)
    const unknownTool=await fetch(base+'/api/v1/usage/detail?toolName=unknown')
    assert.equal(unknownTool.status,200)
    assert.deepEqual((await unknownTool.json() as {meta:{native:{tools:unknown[]}}})
      .meta.native.tools,[])
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
  }finally{
    await surface.dispose();await liveAttachments.dispose()
    await rm(agentRoot,{recursive:true,force:true})
  }
})
