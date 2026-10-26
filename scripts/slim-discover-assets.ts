import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeOnlyAssetScanner } from '@agent-lens/core-services'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { DefaultCapturePolicyService, capturePolicySettingsFromEnv } from '@agent-lens/capture-policy'
import { NATIVE_REINDEX_SOURCES } from './slim-reindex-native'

/** Offline only; never operates against the running Legacy database. */
export async function runSlimAssetDiscovery(args:readonly string[]){
  const values=new Map<string,string>()
  for(let i=0;i<args.length;i++){
    const key=args[i]
    if(!key||!['--staging','--source','--installation','--runtime-profile'].includes(key)
      ||values.has(key))throw new TypeError('Invalid asset scan argument')
    const value=args[++i]
    if(!value||value.startsWith('--'))throw new TypeError('Asset scan argument requires a value')
    values.set(key,value)
  }
  const stagingPath=values.get('--staging')
  const sourceId=values.get('--source')
  const installationId=values.get('--installation')
  if(!stagingPath||!sourceId||!installationId){
    throw new Error('Asset scan requires --staging, --source and --installation')
  }
  const source=NATIVE_REINDEX_SOURCES.get(sourceId)
  if(!source)throw new Error('Unsupported asset Source')
  const storage=SqliteSlimStorage.openExisting(stagingPath)
  try{
    const install=await storage.repositories.installations.get(installationId)
    if(!install)throw new Error('Source installation not indexed')
    const host=await storage.repositories.hosts.get(install.hostId)
    if(!host)throw new Error('Source host not indexed')
    const requestedProfile=values.get('--runtime-profile')
    const profile=requestedProfile
      ?await storage.runtimeProfiles.get(requestedProfile):null
    if(requestedProfile&&!profile)throw new Error('Requested runtime profile not indexed')
    const policy=new DefaultCapturePolicyService(capturePolicySettingsFromEnv(process.env))
    return new NativeOnlyAssetScanner(storage.assets,storage.checkpoints,policy).scan({
      source,installation:install,host,
      ...(profile?{runtimeProfile:profile}:{}),
      signal:new AbortController().signal,
    })
  }finally{await storage.close()}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runSlimAssetDiscovery(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Slim asset discovery refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
