import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { resolveDefaultSlimDb, defaultSlimDbPaths } from './default-slim-db.js'
import { startSlimNativeDaemon } from './slim-main.js'

/** Canonical Daemon/CLI/Desktop startup. No v38 Writer, history-sync,
 * SourceRecord events, Cordis observation storage, or old projections.
 */
export async function startDefaultDaemon(env:NodeJS.ProcessEnv=process.env){
  const result=await resolveDefaultSlimDb(defaultSlimDbPaths(env))
  const port=env.AGENT_LENS_PORT?Number(env.AGENT_LENS_PORT):undefined
  if(port!==undefined&&(!Number.isSafeInteger(port)||port<0||port>65535)){
    throw new RangeError('Invalid AgentLens daemon port')
  }
  return startSlimNativeDaemon({
    dbPath:result.dbPath,
    ...(port===undefined?{}:{port}),
  })
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startDefaultDaemon().then(running=>{
    console.info('[AgentLens] native-only default Daemon:',running.http.port)
    let closing=false
    for(const signal of ['SIGINT','SIGTERM'] as const){
      process.once(signal,()=>{
        if(closing)return
        closing=true
        void running.dispose().then(()=>{process.exitCode=0}).catch(error=>{
          console.error('[AgentLens] Slim shutdown failed',error)
          process.exitCode=1
        })
      })
    }
  }).catch(error=>{
    console.error('[AgentLens] native-only default startup refused',
      error instanceof Error?error.message:String(error))
    process.exitCode=1
  })
}
