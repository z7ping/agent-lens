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
export function parseHermesHelpCommands(help: string): ReadonlySet<string> {
  const text = help.replace(/\x1B\[[0-9;]*m/g,'')
  const commands = new Set<string>()
  // argparse prints known subcommands as {create,edit,...} in usage and options.
  for (const found of text.matchAll(/\{([a-z][a-z0-9_, -]{0,1600})\}/gi)) {
    for (const token of found[1]!.split(',')) {
      const command = token.trim().toLowerCase()
      if (/^[a-z][a-z0-9-]{0,40}$/.test(command))commands.add(command)
    }
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
const probeArgs:readonly string[][] = [
  ['kanban','boards','--help'],
  ['kanban','--help'],
  ['--profile','default','cron','--help'],
]

async function probeCommands(executable:string,root:string,args:string[]):Promise<ReadonlySet<string>> {
  try {
    const {stdout,stderr}=await execFileAsync(executable,args,{
      cwd:root,env:{...process.env,HERMES_HOME:root},encoding:'utf8',
      timeout:4000,maxBuffer:32*1024,windowsHide:true,shell:false,
    })
    const output=stdout+'\n'+stderr
    if(!/(?:usage:|options:|optional arguments:)/i.test(output))return new Set()
    return parseHermesHelpCommands(output)
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
  const promise=Promise.all(probeArgs.map(args=>probeCommands(executable,root,args)))
    .then(commands=>(Object.entries(actionCommand) as [Kind,readonly [number,string]][])
      .filter(([, [index,verb]])=>commands[index]!.has(verb))
      .map(([kind])=>kind))
  cache.set(key,{expiresAt:now+TTL_MS,promise})
  return promise
}
