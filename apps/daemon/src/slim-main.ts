import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultCapturePolicyService, resolveCapturePolicyPluginState } from '@agent-lens/capture-policy'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { DefaultSourceService } from '@agent-lens/core-services'
import { piSourceDefinition } from '@agent-lens/source-pi'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import { claudeSourceDefinition } from '@agent-lens/source-claude'
import { hermesSourceDefinition } from '@agent-lens/source-hermes'
import { openCodeSourceDefinition } from '@agent-lens/source-opencode'
import { startNativeOnlyHttpSurface } from '@agent-lens/surface-http'
import { SlimDataRuntime } from './data-runtime/slim-runtime.js'

export interface SlimDaemonOptions {
  /** Existing slim v1 only; absent/v38 paths are never upgraded at boot. */
  dbPath:string
  port?:number
  /** Testable injection, not a Legacy StorageService adapter. */
  runtime?:SlimDataRuntime
  sources?:SourceService
  capturePolicy?:CapturePolicyService
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
      editable:false,
      configuredEnabledSources:resolved.settings.enabledSources,
    },
  )
  await runtime.start()
  try {
    const http=await startNativeOnlyHttpSurface(runtime.nativeHttpPort(),{
      port:options.port,sources,capturePolicy:policy,
      reader:runtime.nativeReader(sources,policy),
    })
    let closed=false
    return {
      http,runtime,
      async dispose(){
        if(closed)return
        closed=true
        try{await http.dispose()}finally{await runtime.shutdown()}
      },
    }
  }catch(error){
    await runtime.shutdown()
    throw error
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===join(process.cwd(),
  process.argv[1].replace(/^\.\//,''))){
  const dbPath=process.env.AGENT_LENS_DB_PATH
  if(!dbPath){
    throw new Error('Slim-native Daemon requires explicit AGENT_LENS_DB_PATH pointing to a migrated slim-v1 database')
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
