import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AgentWorkMutationDto } from '@agent-lens/protocol'

const execFileAsync = promisify(execFile)
type Kind = AgentWorkMutationDto['kind']
type Probe = { roots:string[]; executable?:string }
const TTL_MS = 60_000
const MAX_PROBES = 32
const cache = new Map<string, { expiresAt:number; promise:Promise<Kind[]> }>()

/** Extract only argparse subcommand choice groups; prose is not evidence of support. */
export function parseHermesHelpCommands(
  help: string,
  expectedPath: readonly string[] = [],
): ReadonlySet<string> {
  const text = help.replace(/\x1B\[[0-9;]*m/g, '')
  // Only the argparse usage line is authoritative: other {a,b} groups may
  // describe a flag's valid values, not executable subcommands.
  const usage = text.match(/(?:^|\n)\s*usage:\s*(hermes(?:\.exe)?\b[^\n]*?(?:\n(?!\s*(?:options:|optional arguments:|positional arguments:|\w[^\n]*:))\s+[^\n]*){0,8})/i)?.[1]
  if (!usage) return new Set()
  const normalized = usage.replace(/\s+/g, ' ').trim()
  if (expectedPath.length) {
    const prefix = 'hermes ' + expectedPath.join(' ')
    // Child-parser help should identify the command we are probing; do not
    // interpret a different command's help as permission to run native writes.
    if (!normalized.startsWith(prefix + ' ') && normalized !== prefix) return new Set()
  }
  const choice = normalized.match(/\{([a-z][a-z0-9_, -]{0,1600})\}/i)?.[1]
  if (!choice) return new Set()
  const commands = new Set<string>()
  for (const token of choice.split(',')) {
    const command = token.trim().toLowerCase()
    if (/^[a-z][a-z0-9-]{0,40}$/.test(command)) commands.add(command)
  }
  return commands
}

const actionCommand: Readonly<Record<Kind,readonly [number,string]>> = {
  'board.create':[0,'create'],'board.rename':[0,'rename'],'board.archive':[0,'rm'],
  'task.create':[1,'create'],'task.edit':[1,'edit'],'task.assign':[1,'assign'],
  'task.link':[1,'link'],'task.unlink':[1,'unlink'],'task.archive':[1,'archive'],
  'task.block':[1,'block'],'task.unblock':[1,'unblock'],
  'task.complete':[1,'complete'],'task.promote':[1,'promote'],
  'cron.create':[2,'create'],'cron.edit':[2,'edit'],'cron.pause':[2,'pause'],
  'cron.resume':[2,'resume'],'cron.remove':[2,'remove'],
  'cron.cancel':[2,'cancel'],'cron.run':[2,'run'],
}
/** Pure command-set mapping; only commands seen in native --help are exposed. */
export function commandsToWorkspaceActions(
  groups:readonly ReadonlySet<string>[],
):Kind[] {
  return (Object.entries(actionCommand) as [Kind,readonly [number,string]][])
    .filter(([, [index,verb]])=>Boolean(groups[index]?.has(verb)))
    .map(([kind])=>kind)
}

const probeArgs:readonly string[][] = [
  ['kanban','boards','--help'],
  ['kanban','--help'],
  ['--profile','default','cron','--help'],
]

async function probeCommands(executable:string,root:string,args:string[],expectedPath:readonly string[]):Promise<ReadonlySet<string>> {
  try {
    const {stdout,stderr}=await execFileAsync(executable,args,{
      cwd:root,env:{...process.env,HERMES_HOME:root},encoding:'utf8',
      timeout:4000,maxBuffer:32*1024,windowsHide:true,shell:false,
    })
    const output=stdout+'\n'+stderr
    if(!/(?:usage:|options:|optional arguments:)/i.test(output))return new Set()
    return parseHermesHelpCommands(output, expectedPath)
  }catch {
    // Old, missing or incompatible Hermes CLI: fail closed, never guess.
    return new Set()
  }
}

/** Per-installation probing is read-only, cached, bounded and shared in-flight. */
export async function probeHermesWorkspaceActions(options:Probe):Promise<Kind[]> {
  if(options.roots.length!==1 || !isAbsolute(options.roots[0]??''))return []
  const root=resolve(options.roots[0]!)
  const executable=options.executable??'hermes'
  if(!executable || executable.includes('\0'))return []
  const key=JSON.stringify([root,executable])
  const now=Date.now()
  const cached=cache.get(key)
  if(cached && cached.expiresAt>now)return cached.promise
  if(cache.size>=MAX_PROBES)cache.delete(cache.keys().next().value!)
  const promise=Promise.all(probeArgs.map((args,index)=>probeCommands(executable,root,args,
    index===0?['kanban','boards']:index===1?['kanban']:['cron'])))
    .then(commands=>commandsToWorkspaceActions(commands))
  cache.set(key,{expiresAt:now+TTL_MS,promise})
  return promise
}
