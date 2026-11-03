import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { resolveHermesConfigRoots } from '@agent-lens/runtime-cordis'
import type { AgentWorkOutputFileDto, AgentWorkOutputResponseDto } from '@agent-lens/protocol'

const JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/
const PROFILE = /^[a-zA-Z0-9_-]{1,80}$/
const OUTPUT_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/
const PAGE = 50
const MAX_PREVIEW_BYTES = 256 * 1024

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep)

/** Cron output is strictly a profile-local native Markdown artifact. */
export async function readHermesCronOutput(options: {
  roots?: string[]
  profile: string
  jobId: string
  file?: string
  offset?: number
}): Promise<AgentWorkOutputResponseDto> {
  const {profile,jobId,file}=options
  if (!PROFILE.test(profile) || !JOB_ID.test(jobId) || (file && !OUTPUT_NAME.test(file))) {
    throw new Error('Invalid Hermes Cron output identity')
  }
  const unavailable:AgentWorkOutputResponseDto={
    sourceId:'hermes',profile,jobId,files:[],hasMore:false,state:'unavailable',
  }
  const candidates = options.roots ?? resolveHermesConfigRoots()
  const roots = [...new Set(candidates.map(root=>basename(dirname(root))==='profiles'?dirname(dirname(root)):root))]
  for (const root of roots) {
    const home=profile==='default'?root:join(root,'profiles',profile)
    const outputHome=join(home,'cron','output')
    const folder=join(outputHome,jobId)
    try {
      // Do not allow symlinked folders to escape a verified installation/profile.
      const [homePath,basePath,folderPath]=await Promise.all([
        realpath(home),realpath(outputHome),realpath(folder),
      ])
      if (!inside(homePath,basePath) || !inside(basePath,folderPath) || folderPath===basePath) {
        throw new Error('Hermes Cron output is outside its profile root')
      }
      const records=await readdir(folder,{withFileTypes:true})
      const names=records.filter(entry=>entry.isFile() && OUTPUT_NAME.test(entry.name))
        .map(entry=>entry.name).sort((a,b)=>b.localeCompare(a))
      const offset=Math.max(0,Math.min(100000,Math.floor(options.offset??0)))
      const selected=names.slice(offset,offset+PAGE)
      const files:AgentWorkOutputFileDto[]=await Promise.all(selected.map(async name=>{
        const info=await stat(join(folder,name))
        return {name,bytes:info.size,modifiedAt:info.mtime.toISOString()}
      }))
      if (file) {
        if (!names.includes(file)) return unavailable
        const path=join(folder,file)
        const info=await lstat(path)
        const canonical=await realpath(path)
        if (!inside(folderPath,canonical) || !info.isFile() || info.size > MAX_PREVIEW_BYTES) {
          throw new Error('Hermes Cron output preview exceeds file budget')
        }
        return {sourceId:'hermes',profile,jobId,files,hasMore:offset+PAGE<names.length,
          state:'available',preview:{name:file,text:await readFile(path,'utf8')}}
      }
      return {sourceId:'hermes',profile,jobId,files,hasMore:offset+PAGE<names.length,state:'available'}
    } catch (error) {
      if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')) continue
      throw error
    }
  }
  return unavailable
}
