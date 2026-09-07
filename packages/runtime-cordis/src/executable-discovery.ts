import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHELL_PATH_BEGIN = '__AGENT_LENS_PATH_BEGIN__'
const SHELL_PATH_END = '__AGENT_LENS_PATH_END__'
const DISCOVERY_TIMEOUT_MS = 1500
const MAX_DISCOVERY_OUTPUT = 128 * 1024
const SHIM_PROBE_BYTES = 8 * 1024

export interface ExecutableDiscoveryOptions {
  explicit?: string | undefined
  envVar?: string | undefined
  platform?: NodeJS.Platform | undefined
  pathValue?: string | undefined
  shellPathResolver?: (() => Promise<string | undefined>) | undefined
}

interface ShimResolver {
  id: 'volta' | 'mise' | 'asdf'
  managerCommand: string
  targetArgs(name: string): string[]
  matches(executable: string, managerExecutable: string, platform: NodeJS.Platform): Promise<boolean>
}

function pathRoots(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return []
  const separator = platform === 'win32' ? ';' : ':'
  return value
    .split(separator)
    .map(item => item.length >= 2 && item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item)
    .filter(Boolean)
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || extname(name)) return [name]
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return [name, ...extensions.map(extension => `${name}${extension}`)]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isUsableExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

async function sameCanonicalPath(a: string, b: string, platform: NodeJS.Platform): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalPath(a), canonicalPath(b)])
  return comparablePath(left, platform) === comparablePath(right, platform)
}

async function sameDirectory(a: string, b: string, platform: NodeJS.Platform): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalPath(dirname(a)), canonicalPath(dirname(b))])
  return comparablePath(left, platform) === comparablePath(right, platform)
}

async function readPrefix(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.allocUnsafe(SHIM_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function findInPath(name: string, pathValue: string | undefined, platform: NodeJS.Platform): Promise<string | undefined> {
  const names = executableNames(name, platform)
  for (const root of pathRoots(pathValue, platform)) {
    for (const candidateName of names) {
      const candidate = join(root, candidateName)
      if (await isUsableExecutable(candidate, platform)) return candidate
    }
  }
  return undefined
}

function shellCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return []
  const defaults = platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/zsh', '/bin/sh']
  return [...new Set([process.env.SHELL?.trim(), ...defaults].filter((value): value is string => Boolean(value)))]
}

function parseShellPath(output: string): string | undefined {
  const start = output.lastIndexOf(SHELL_PATH_BEGIN)
  if (start < 0) return undefined
  const valueStart = start + SHELL_PATH_BEGIN.length
  const end = output.indexOf(SHELL_PATH_END, valueStart)
  if (end < 0) return undefined
  const value = output.slice(valueStart, end)
  return value || undefined
}

async function readPathFromShell(shell: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(shell, [
      '-ilc',
      `printf '${SHELL_PATH_BEGIN}%s${SHELL_PATH_END}' "$PATH"; exit`,
    ], {
      windowsHide: true,
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: MAX_DISCOVERY_OUTPUT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTARTED: 'true',
        ZSH_TMUX_AUTOSTART: 'false',
      },
    })
    return parseShellPath(stdout)
  } catch {
    return undefined
  }
}

export async function resolveLoginShellPath(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  for (const shell of shellCandidates(platform)) {
    const value = await readPathFromShell(shell)
    if (value) return value
  }
  return undefined
}

export async function resolveExecutable(
  name: string,
  options: ExecutableDiscoveryOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform

  for (const candidate of [
    options.explicit?.trim(),
    options.envVar ? process.env[options.envVar]?.trim() : undefined,
  ]) {
    if (candidate && await isUsableExecutable(candidate, platform)) return candidate
  }

  const currentPath = options.pathValue ?? process.env.PATH
  const fromCurrentPath = await findInPath(name, currentPath, platform)
  if (fromCurrentPath) return fromCurrentPath

  const fromNodeDirectory = await findInPath(name, dirname(process.execPath), platform)
  if (fromNodeDirectory) return fromNodeDirectory

  if (platform !== 'win32') {
    const shellPath = await (options.shellPathResolver ?? (() => resolveLoginShellPath(platform)))()
    if (shellPath && shellPath !== currentPath) {
      const fromShellPath = await findInPath(name, shellPath, platform)
      if (fromShellPath) return fromShellPath
    }
  }

  return undefined
}

const shimResolvers: readonly ShimResolver[] = [
  {
    id: 'volta',
    managerCommand: 'volta',
    targetArgs: name => ['which', name],
    matches: (executable, managerExecutable, platform) => sameDirectory(executable, managerExecutable, platform),
  },
  {
    id: 'mise',
    managerCommand: 'mise',
    targetArgs: name => ['which', name],
    matches: (executable, managerExecutable, platform) => sameCanonicalPath(executable, managerExecutable, platform),
  },
  {
    id: 'asdf',
    managerCommand: 'asdf',
    targetArgs: name => ['which', name],
    matches: async executable => {
      const prefix = await readPrefix(executable)
      return Boolean(prefix && /\basdf\s+exec\b/.test(prefix))
    },
  },
]

async function resolveWithShimManager(
  resolver: ShimResolver,
  name: string,
  executable: string,
  options: Pick<ExecutableDiscoveryOptions, 'platform' | 'pathValue' | 'shellPathResolver'>,
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const managerExecutable = await resolveExecutable(resolver.managerCommand, {
    platform,
    pathValue: options.pathValue,
    shellPathResolver: options.shellPathResolver,
  })
  if (!managerExecutable || !await resolver.matches(executable, managerExecutable, platform)) return undefined

  try {
    const { stdout } = await execFileAsync(managerExecutable, resolver.targetArgs(name), {
      windowsHide: true,
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: MAX_DISCOVERY_OUTPUT,
      encoding: 'utf8',
      env: process.env,
    })
    const candidate = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    return candidate && await pathExists(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

export async function resolveManagedExecutableTarget(
  name: string,
  executable: string,
  options: Pick<ExecutableDiscoveryOptions, 'platform' | 'pathValue' | 'shellPathResolver'> = {},
): Promise<string> {
  const directTarget = await canonicalPath(executable)
  if (directTarget !== executable) return directTarget

  for (const resolver of shimResolvers) {
    const target = await resolveWithShimManager(resolver, name, executable, options)
    if (target) return target
  }

  return executable
}
