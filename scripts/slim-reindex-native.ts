import { basename as invocationBaseName } from 'node:path'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SourceDefinition } from '@agent-lens/core'
import { indexNativeInstallation } from '@agent-lens/core-services'
import { SqliteSlimStorage } from '@agent-lens/storage-sqlite'
import { piSourceDefinition } from '@agent-lens/source-pi'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import { claudeSourceDefinition } from '@agent-lens/source-claude'
import { hermesSourceDefinition } from '@agent-lens/source-hermes'
import { openCodeSourceDefinition } from '@agent-lens/source-opencode'

export const NATIVE_REINDEX_SOURCES:ReadonlyMap<string,SourceDefinition>=new Map([
  piSourceDefinition,codexSourceDefinition,claudeSourceDefinition,
  hermesSourceDefinition,openCodeSourceDefinition,
].map(source=>[source.manifest.sourceId,source] as const))

export interface NativeReindexArgs {
  stagingPath:string
  sourceId:string
  installationId:string
  runtimeProfileId?:string
  maxSessions:number
  activeSince?:string
}

export function parseNativeReindexArgs(args:readonly string[]):NativeReindexArgs {
  const values=new Map<string,string>()
  for(let i=0;i<args.length;i++) {
    const flag=args[i]
    if(!flag || !['--staging','--source','--installation',
      '--runtime-profile','--limit','--since'].includes(flag)) {
      throw new Error('Unsupported native reindex argument: '+flag)
    }
    const value=args[++i]
    if(!value || value.startsWith('--') || values.has(flag)) {
      throw new Error('Missing or repeated native reindex argument: '+flag)
    }
    values.set(flag,value)
  }
  const stagingPath=values.get('--staging')
  const sourceId=values.get('--source')
  const installationId=values.get('--installation')
  if(!stagingPath || !sourceId || !installationId) {
    throw new Error('Native reindex requires --staging, --source and --installation')
  }
  if(!NATIVE_REINDEX_SOURCES.has(sourceId)) throw new Error('Native reindex unsupported Source: '+sourceId)
  const maxSessions=values.has('--limit')?Number(values.get('--limit')):32
  if(!Number.isSafeInteger(maxSessions) || maxSessions<1 || maxSessions>5000) {
    throw new RangeError('Native reindex --limit must be between 1 and 5000')
  }
  const activeSince=values.get('--since')
  if(activeSince && (!Number.isFinite(Date.parse(activeSince))
    || !/^\d{4}-\d{2}-\d{2}T/.test(activeSince))) {
    throw new TypeError('Native reindex --since must be an ISO date-time')
  }
  return {stagingPath,sourceId,installationId,maxSessions,
    ...(values.has('--runtime-profile')?{runtimeProfileId:values.get('--runtime-profile')}:{}),
    ...(activeSince?{activeSince}:{})}
}

/** Explicit only: indexes original Source files into a PREEXISTING slim
 * staging DB. Never opens or writes the legacy DB, never starts old Writer,
 * never changes the active application's installed database pointer.
 */
export async function runNativeReindex(args:readonly string[]) {
  const input=parseNativeReindexArgs(args)
  const source=NATIVE_REINDEX_SOURCES.get(input.sourceId)!
  const slim=SqliteSlimStorage.openExisting(input.stagingPath)
  try {
    const profile=input.runtimeProfileId
      ? await slim.runtimeProfiles.get(input.runtimeProfileId)
      : undefined
    if(input.runtimeProfileId && !profile){
      throw new Error('Native reindex runtime profile is not indexed')
    }
    return await indexNativeInstallation(slim,{
      source,installationId:input.installationId,
      ...(profile?{runtimeProfile:profile}:{}),
      signal:new AbortController().signal,
      maxSessions:input.maxSessions,
      fullEnumeration:true,
      ...(input.activeSince?{historyWindow:{activeSince:input.activeSince}}:{}),
    })
  } finally {
    await slim.close()
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)
  &&["slim-reindex-native.ts","slim-reindex-native.js","slim-reindex-native.mjs"].includes(invocationBaseName(process.argv[1]))){
  runNativeReindex(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write('Native reindex refused: '+
      (error instanceof Error?error.message:String(error))+'\n')
    process.exitCode=1
  })
}
