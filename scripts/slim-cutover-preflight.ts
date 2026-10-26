import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  inspectLegacyCutover,
  stageSlimCutover,
  auditSlimNativeCoverage,
} from '../packages/storage-sqlite/src/index'

type Command = 'preflight' | 'stage' | 'verify'

export interface CutoverCliArgs {
  command: Command
  legacyPath: string
  backupPath?: string
  stagingPath?: string
}

export function parseCutoverArgs(args: readonly string[]): CutoverCliArgs {
  const command = args[0]
  if (command !== 'preflight' && command !== 'stage' && command !== 'verify') {
    throw new Error('Use preflight, stage or verify (never auto-switch or auto-delete)')
  }
  const named = new Map<string,string>()
  for (let i=1;i<args.length;i++) {
    const flag=args[i]
    if (!['--legacy','--backup','--staging'].includes(flag||'')) {
      throw new Error('Unsupported flag: ' + flag)
    }
    const value=args[++i]
    if (!value || value.startsWith('--') || named.has(flag!)) {
      throw new Error('Missing or repeated argument: ' + flag)
    }
    named.set(flag!,value)
  }
  const legacyPath=named.get('--legacy')
  if (!legacyPath) throw new Error('An explicit --legacy path is required')
  if (command==='preflight') {
    if (named.has('--backup') || named.has('--staging')) {
      throw new Error('Preflight is strictly read-only; omit --backup and --staging')
    }
    return {command,legacyPath}
  }
  const backupPath=named.get('--backup')
  const stagingPath=named.get('--staging')
  if(command==='verify') {
    if(!stagingPath || backupPath) {
      throw new Error('Verify requires --staging and rejects --backup; both DBs are read-only')
    }
    return {command,legacyPath,stagingPath}
  }
  if (!backupPath || !stagingPath) {
    throw new Error('Stage requires both --backup and --staging (new, separate paths)')
  }
  return {command,legacyPath,backupPath,stagingPath}
}

/** Diagnostic command only. It can create a backup/staging DB but NEVER
 * stops daemons, changes the installed DB pointer, drops tables or deletes data.
 */
export async function runSlimCutoverCli(args: readonly string[]): Promise<object> {
  const options=parseCutoverArgs(args)
  if (options.command==='preflight') {
    const db=new Database(options.legacyPath,{readonly:true,fileMustExist:true})
    try {
      return inspectLegacyCutover(db)
    } finally {
      db.close()
    }
  }
  if(options.command==='verify') {
    if(!options.stagingPath) throw new Error('Verify staging path required')
    const old=new Database(options.legacyPath,{readonly:true,fileMustExist:true})
    try {
      const slim=new Database(options.stagingPath,{readonly:true,fileMustExist:true})
      try { return auditSlimNativeCoverage(old,slim) }
      finally { slim.close() }
    } finally { old.close() }
  }
  if (!options.backupPath || !options.stagingPath) throw new Error('Stage paths required')
  const result=await stageSlimCutover({
    legacyPath:options.legacyPath,
    backupPath:options.backupPath,
    stagingPath:options.stagingPath,
  })
  // The reports contain counts only, not SQL payloads or checkpoint JSON.
  return result
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runSlimCutoverCli(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n')
  }).catch(error=>{
    process.stderr.write(`Slim cutover refused: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode=1
  })
}
