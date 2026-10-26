import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { startLocalVault } from '@agent-lens/backup-local'
import { NpmPiEcosystemProvider } from '@agent-lens/integration-pi'
import { IntegrationPackageService } from '@agent-lens/integration-packages'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCapturePolicyService, resolveCapturePolicyPluginState, writeCapturePolicyConfiguration } from '@agent-lens/capture-policy'
import { authorizedIntegrationCapabilities, integrationAuthorizationPath, readIntegrationAuthorizationSync } from '@agent-lens/runtime-cordis'
import type { BackupService, CapturePolicyService, SourceService, LiveService, LiveAttachmentService } from '@agent-lens/core'
import { DefaultSourceService } from '@agent-lens/core-services'
import { piSourceDefinition } from '@agent-lens/source-pi'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import { claudeSourceDefinition } from '@agent-lens/source-claude'
import { hermesSourceDefinition } from '@agent-lens/source-hermes'
import { openCodeSourceDefinition } from '@agent-lens/source-opencode'
import { startNativeOnlyHttpSurface, previewLocalHostTextFile, type IntegrationPackageController } from '@agent-lens/surface-http'
import { IntegrationPackageService } from '@agent-lens/integration-packages'
import type { PiEcosystemQueryService } from '@agent-lens/protocol'
import { openLocalPath } from './local-path-opener.js'
import { SlimDataRuntime } from './data-runtime/slim-runtime.js'
import { SlimSourceCoordinator } from './slim-source-coordinator.js'
import { startSlimLive } from './slim-live.js'
import { startSlimIntegrations } from './slim-integrations.js'

export interface SlimDaemonOptions {
  /** Existing slim v1 only; absent/v38 paths are never upgraded at boot. */
  dbPath:string
  port?:number
  /** Existing web build; uses the same static bundle as the default Daemon. */
  webRoot?:string
  localePackDirectory?:string
  vaultPath?:string
  /** Test-only external existing Vault; otherwise compose the same Local Vault as Cordis. */
  backup?:BackupService
  /** Test injection for the existing remote Pi catalog; never persisted to SQLite. */
  piEcosystem?:PiEcosystemQueryService
  /** Test-injected existing package lifecycle controller. */
  integrationPackages?:Pick<IntegrationPackageService,
    'catalog'|'statesSnapshot'|'state'|'install'|'update'|'remove'|'operation'>
  /** Test-only injected Live Registry/attachments; real runtime is Pi Worker. */
  lives?:LiveService
  liveAttachments?:LiveAttachmentService
  /** Testable injection, not a Legacy StorageService adapter. */
  runtime?:SlimDataRuntime
  sources?:SourceService
  capturePolicy?:CapturePolicyService
  /** Tests can inject the official package lifecycle, no second implementation. */
  integrationPackages?:IntegrationPackageController
}

export function resolveSlimWebRoot(configured?:string):string{
  if(configured)return configured
  if(process.env.AGENT_LENS_WEB_ROOT)return process.env.AGENT_LENS_WEB_ROOT
  const bundled=fileURLToPath(new URL('./web/',import.meta.url))
  const workspace=fileURLToPath(new URL('../../../packages/web/dist/',import.meta.url))
  return existsSync(join(bundled,'index.html'))?bundled:workspace
}

export function registeredNativeSources():SourceService{
  const sources=new DefaultSourceService()
  for(const source of [piSourceDefinition,codexSourceDefinition,
    claudeSourceDefinition,hermesSourceDefinition,openCodeSourceDefinition]){
    sources.register(source)
  }
  return sources
}

/** Standalone Slim-native control/read plane. No v38 Cordis plugins,
 * Legacy Writer, SQL event projections or historical Source Sync may start.
 * Unported product endpoints remain 501 until consumers are migrated.
 */
export async function startSlimNativeDaemon(options:SlimDaemonOptions){
  const runtime=options.runtime??new SlimDataRuntime({dbPath:options.dbPath})
  const sources=options.sources??registeredNativeSources()
  const resolved=resolveCapturePolicyPluginState()
  const policy=options.capturePolicy??new DefaultCapturePolicyService(
    resolved.settings,{
      source:resolved.configurationSource,
      editable:resolved.editable,
      configurationPath:resolved.configurationPath,
      configuredEnabledSources:resolved.settings.enabledSources,
      writeEnabledSources:async next=>{
        await writeCapturePolicyConfiguration(resolved.configurationPath,next)
      },
    },
  )
  if(Boolean(options.lives)!==Boolean(options.liveAttachments)){
    throw new TypeError('Slim Live Registry and attachment store must be injected together')
  }
  await runtime.start()
  let vault:ReturnType<typeof startLocalVault>|undefined
  let live:Awaited<ReturnType<typeof startSlimLive>>|undefined
  try {
    if(!options.backup){
      const vaultPath=options.vaultPath??process.env.AGENT_LENS_VAULT_PATH
        ??join(homedir(),'.agent-lens','1.0','vault')
      const sourceOrder=[
        ...new Set([
          ...resolved.settings.enabledSources,
          ...sources.list().map(source=>source.manifest.sourceId),
        ]),
      ]
      // The existing Vault owns original backup files; only its lightweight
      // Source checkpoint state and identities come from Slim storage.
      vault=startLocalVault(
        {checkpoints:runtime.nativePort().checkpoints},sources,
        {
          resolveHost:hint=>runtime.resolveHost(hint),
          resolveInstallation:hint=>runtime.resolveInstallation(hint),
        },
        {vaultPath,sourceOrder},
      )
    }
    const httpPort=runtime.nativeHttpPort()
    const nativeReader=runtime.nativeReader(sources,policy)
    if(!options.lives){
      const permissions=readIntegrationAuthorizationSync(integrationAuthorizationPath())
      const enabledLiveProducts=new Set(['pi','codex','hermes'].filter(productId=>
        authorizedIntegrationCapabilities(permissions,productId).includes('live')))
      live=await startSlimLive(
        runtime.nativePort().checkpoints,
        httpPort.nativeSessionCatalog,nativeReader,policy,enabledLiveProducts,
      )
    }
    // Exactly the existing package service (bundle checksums, atomically
    // installed pointers and restart semantics), not a Slim-only installer.
    let packages:IntegrationPackageController|undefined=options.integrationPackages
    if(!packages&&!options.runtime){
      const bundled=fileURLToPath(new URL('./integration-packages/',import.meta.url))
      const workspace=fileURLToPath(new URL('../../../dist/integration-packages/',import.meta.url))
      const bundleDir=process.env.AGENT_LENS_INTEGRATION_BUNDLE_DIR
        ??(existsSync(join(bundled,'catalog.json'))?bundled:workspace)
      const installRoot=process.env.AGENT_LENS_INTEGRATIONS_DIR
        ??join(homedir(),'.agent-lens','1.0','integrations')
      const service=new IntegrationPackageService({
        bundleDir,installRoot,
        canRemove:id=>{
          const loaded=sources.list().some(source=>source.manifest.productId===id
            &&policy.isSourceEnabled(source.manifest.sourceId))
          return loaded?{
            allowed:false,reason:'Disable Integration Source and restart before removal',
          }:{allowed:true}
        },
      })
      try{
        await service.initialize()
        packages={
          catalog:()=>service.catalog(),
          states:()=>service.statesSnapshot(),
          state:id=>{try{return service.state(id)}catch{return null}},
          install:id=>service.install(id),
          remove:id=>service.remove(id),
          update:id=>service.update(id),
          operation:id=>service.operation(id),
        }
      }catch(error){
        console.warn('[AgentLens] Slim official package lifecycle unavailable',error)
      }
    }
    const integrations=startSlimIntegrations({
      sources,policy,lives:options.lives??live!.lives,
      scanOnStart:!options.runtime,
    })
    // The same verified, atomically installed official Integration package
    // lifecycle as the old Daemon, but no Legacy physicalization or Writer.
    // Disabled/active Source and Live registrations may not be removed while
    // the current process still owns their resources.
    let integrationPackages=options.integrationPackages
    if(!integrationPackages&&!options.runtime){
      const bundled=fileURLToPath(new URL('./integration-packages/',import.meta.url))
      const workspace=fileURLToPath(new URL('../../../dist/integration-packages/',import.meta.url))
      const bundleDir=process.env.AGENT_LENS_INTEGRATION_BUNDLE_DIR
        ??(existsSync(join(bundled,'catalog.json'))?bundled:workspace)
      const installRoot=process.env.AGENT_LENS_INTEGRATIONS_DIR
        ??join(homedir(),'.agent-lens','1.0','integrations')
      const service=new IntegrationPackageService({
        bundleDir,installRoot,
        canRemove:integrationId=>{
          const enabled=sources.list().some(source=>
            source.manifest.productId===integrationId
            &&policy.isSourceEnabled(source.manifest.sourceId))
          const liveRegistered=(options.lives??live!.lives).list().some(adapter=>
            adapter.manifest.productId===integrationId)
          return enabled||liveRegistered
            ?{allowed:false,reason:'Integration is active; disable and restart before removal'}
            :{allowed:true}
        },
      })
      try{
        await service.initialize()
        integrationPackages=service
      }catch(error){
        console.warn('[AgentLens] Slim Integration package service unavailable',error)
      }
    }
    let notifyActivity=()=>{}
    const coordinator=new SlimSourceCoordinator(runtime,sources,policy,policy,
      ()=>notifyActivity())
    const http=await startNativeOnlyHttpSurface(httpPort,{
      backgroundProgress:()=>coordinator.snapshot(),
      ...(options.port===undefined?{}:{port:options.port}),
      sources,capturePolicy:policy,
      ...(policy.isSourceEnabled('pi')?{
        piEcosystem:options.piEcosystem??new NpmPiEcosystemProvider(),
      }:{}),
      openHostPath:openLocalPath,
      previewHostFile:previewLocalHostTextFile,
      integrationManagement:integrations.management,
      integrationDiscovery:integrations.discovery,
      integrationAuthorization:integrations.authorization,
      ...(integrationPackages?{integrationPackages:{
        catalog:()=>integrationPackages!.catalog(),
        states:()=>integrationPackages!.statesSnapshot(),
        state:(id:string)=>{try{return integrationPackages!.state(id)}catch{return null}},
        install:(id:string)=>integrationPackages!.install(id),
        update:(id:string)=>integrationPackages!.update(id),
        remove:(id:string)=>integrationPackages!.remove(id),
        operation:(id:string)=>integrationPackages!.operation(id),
      }}:{}),
      ...(packages?{integrationPackages:packages}:{}),
      backup:options.backup??vault!.service,
      lives:options.lives??live!.lives,
      liveAttachments:options.liveAttachments??live!.attachments,
      staticDir:resolveSlimWebRoot(options.webRoot),
      ...(options.localePackDirectory?{localePackDirectory:options.localePackDirectory}:{}),
      reader:nativeReader,
    })
    notifyActivity=()=>http.notifyBackgroundActivity()
    // HTTP is already ready; directory scans are now isolated, bounded and
    // asynchronous, so startup never waits for large original Source roots.
    coordinator.start()
    let closed=false
    return {
      http,runtime,coordinator,
      async dispose(){
        if(closed)return
        closed=true
        try{await http.dispose()}finally{
          try{await coordinator.dispose()}finally{
            vault?.stop()
            try{await live?.dispose()}finally{await runtime.shutdown()}
          }
        }
      },
    }
  }catch(error){
    vault?.stop()
    try{await live?.dispose()}finally{await runtime.shutdown()}
    throw error
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const dbPath=process.env.AGENT_LENS_DB_PATH
  if(!dbPath||!isAbsolute(dbPath)){
    throw new Error('Slim-native Daemon requires absolute AGENT_LENS_DB_PATH pointing to an existing slim-v1 database')
  }
  const port=process.env.AGENT_LENS_PORT
    ?Number(process.env.AGENT_LENS_PORT):undefined
  const running=await startSlimNativeDaemon({dbPath,...(port===undefined?{}:{port})})
  console.info('[AgentLens] native-only Daemon HTTP listening:',running.http.port)
  for(const signal of ['SIGINT','SIGTERM'] as const){
    process.once(signal,()=>{
      void running.dispose().then(()=>{process.exitCode=0}).catch(error=>{
        console.error('[AgentLens] native-only shutdown failed',error)
        process.exitCode=1
      })
    })
  }
}
