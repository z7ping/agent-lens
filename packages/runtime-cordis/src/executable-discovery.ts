import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHELL_PATH_BEGIN = '__AGENT_LENS_PATH_BEGIN__'
const SHELL_PATH_END = '__AGENT_LENS_PATH_END__'
const DISCOVERY_TIMEOUT_MS = 1500
const MAX_DISCOVERY_OUTPUT = 128 * 1024

export interface ExecutableDiscoveryOptions {
  explicit?: string | undefined
  envVar?: string | undefined
  platform?: NodeJS.Platform | undefined
  pathValue?: string | undefined
  shellPathResolver?: (() => Promise<string | undefined>) | undefined
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

export async function resolveManagedExecutableTarget(
  name: string,
  executable: string,
  options: Pick<ExecutableDiscoveryOptions, 'platform' | 'pathValue' | 'shellPathResolver'> = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const volta = await resolveExecutable('volta', {
    platform,
    pathValue: options.pathValue,
    shellPathResolver: options.shellPathResolver,
  })
  if (!volta) return executable

  try {
    const { stdout } = await execFileAsync(volta, ['which', name], {
      windowsHide: true,
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: MAX_DISCOVERY_OUTPUT,
      encoding: 'utf8',
      env: process.env,
    })
    const candidate = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (candidate && await pathExists(candidate)) return candidate
  } catch {
    // The executable is not managed by Volta, or Volta cannot resolve it in this context.
  }

  return executable
}
