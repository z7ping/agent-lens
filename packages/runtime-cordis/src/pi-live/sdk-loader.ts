import { access, readFile, realpath } from 'node:fs/promises'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PI_SDK_PACKAGE_NAME,
  assertPiSdkModule,
  inspectPiSdkCompatibility,
  type PiSdkCompatibility,
  type PiSdkModule,
} from './pi-sdk-adapter'

export type {
  PiSdkModel,
  PiSdkModelRuntime,
  PiSdkModule,
  PiSdkPromptOptions,
  PiSdkSession,
  PiSdkSessionManager,
  PiSdkThinkingLevel,
} from './pi-sdk-adapter'

export interface InstalledPiSdk {
  executable: string
  packageRoot: string
  sdkEntry: string
  version?: string | undefined
  compatibility: PiSdkCompatibility
  module: PiSdkModule
}

export type PiSdkLoader = (explicitExecutable?: string) => Promise<InstalledPiSdk>

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function findPiExecutable(explicit?: string): Promise<string | undefined> {
  if (explicit && await exists(explicit)) return explicit
  const configured = process.env.PI_BIN?.trim()
  if (configured && await exists(configured)) return configured
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi.bat'] : ['pi']
  const pathValue = process.env.PATH ?? ''
  for (const root of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

export async function resolveWindowsNpmShimNodeEntry(executable: string): Promise<string | undefined> {
  let source: string
  try {
    source = await readFile(executable, 'utf8')
  } catch {
    return undefined
  }

  const pattern = /%(?:~dp0|dp0%)([^"\r\n]*?\.(?:mjs|cjs|js))/ig
  for (const match of source.matchAll(pattern)) {
    const suffix = match[1]
    if (!suffix) continue
    const normalized = suffix
      .replace(/^[\\/]+/, '')
      .replace(/[\\/]/g, process.platform === 'win32' ? '\\' : '/')
    const candidate = resolve(dirname(executable), normalized)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

async function packageFromEntry(entry: string): Promise<{
  packageRoot: string
  sdkEntry: string
  version?: string | undefined
} | undefined> {
  let cursor = dirname(entry)
  while (true) {
    const manifestPath = join(cursor, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      if (manifest.name === PI_SDK_PACKAGE_NAME) {
        const main = typeof manifest.main === 'string' && manifest.main.trim()
          ? manifest.main
          : './dist/index.js'
        const sdkEntry = resolve(cursor, main)
        if (!await exists(sdkEntry)) {
          throw new Error(`Pi SDK entry declared by ${manifestPath} does not exist: ${sdkEntry}`)
        }
        return {
          packageRoot: cursor,
          sdkEntry,
          ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      if (error instanceof Error && error.message.startsWith('Pi SDK entry declared by ')) throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
}

export async function resolveInstalledPiSdk(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Omit<InstalledPiSdk, 'module'> | undefined> {
  let entry = executable
  const extension = extname(executable).toLowerCase()
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const shimEntry = await resolveWindowsNpmShimNodeEntry(executable)
    if (!shimEntry) return undefined
    entry = shimEntry
  } else {
    entry = await realpath(executable).catch(() => resolve(executable))
  }

  const found = await packageFromEntry(entry)
  if (!found) return undefined
  return {
    executable,
    ...found,
    compatibility: inspectPiSdkCompatibility(found.version),
  }
}

export const loadInstalledPiSdk: PiSdkLoader = async explicitExecutable => {
  const executable = await findPiExecutable(explicitExecutable)
  if (!executable) throw new Error('Pi executable was not found in PATH or PI_BIN')
  const discovery = await resolveInstalledPiSdk(executable)
  if (!discovery) {
    throw new Error(
      `Pi was found at ${executable}, but the official ${PI_SDK_PACKAGE_NAME} SDK could not be located. `
      + 'Install Pi from its official npm package instead of using the removed AgentLens RPC fallback.',
    )
  }
  const imported = await import(pathToFileURL(discovery.sdkEntry).href)
  return {
    ...discovery,
    module: assertPiSdkModule(imported, discovery.sdkEntry, discovery.version),
  }
}
