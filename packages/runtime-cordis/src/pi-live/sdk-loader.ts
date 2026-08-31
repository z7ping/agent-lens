import { access, readFile, realpath } from 'node:fs/promises'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'

export interface PiSdkModel {
  provider: string
  id: string
  name?: string | undefined
  reasoning?: boolean | undefined
}

export interface PiSdkSessionManager {
  getSessionId(): string
  getSessionFile(): string | undefined
  getSessionName(): string | undefined
  getLeafId(): string | null
  getEntries(): unknown[]
}

export interface PiSdkModelRuntime {
  getAvailableSnapshot(): readonly PiSdkModel[]
  getAvailable(providerId?: string): Promise<readonly PiSdkModel[]>
}

export interface PiSdkPromptOptions {
  streamingBehavior?: 'steer' | 'followUp' | undefined
  source?: string | undefined
  preflightResult?: ((success: boolean) => void) | undefined
}

export interface PiSdkSession {
  readonly sessionManager: PiSdkSessionManager
  readonly sessionId: string
  readonly sessionFile: string | undefined
  readonly sessionName: string | undefined
  readonly model: PiSdkModel | undefined
  readonly thinkingLevel: string
  readonly isStreaming: boolean
  readonly isCompacting: boolean
  readonly pendingMessageCount: number
  readonly modelRuntime: PiSdkModelRuntime
  bindExtensions(bindings: Record<string, unknown>): Promise<void>
  subscribe(listener: (event: Record<string, unknown>) => void): () => void
  setSessionName(name: string): void
  setModel(model: PiSdkModel): Promise<void>
  setThinkingLevel(level: string): void
  getAvailableThinkingLevels(): string[]
  prompt(message: string, options?: PiSdkPromptOptions): Promise<void>
  steer(message: string): Promise<void>
  followUp(message: string): Promise<void>
  clearQueue(): { steering: string[]; followUp: string[] }
  abort(): Promise<void>
  waitForIdle(): Promise<void>
  dispose(): void
}

export interface PiSdkModule {
  createAgentSession(options: {
    cwd: string
    sessionManager: PiSdkSessionManager
  }): Promise<{ session: PiSdkSession }>
  SessionManager: {
    create(cwd: string, sessionDir?: string): PiSdkSessionManager
    open(path: string, sessionDir?: string, cwdOverride?: string): PiSdkSessionManager
  }
}

export interface InstalledPiSdk {
  executable: string
  packageRoot: string
  sdkEntry: string
  version?: string | undefined
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
      if (manifest.name === PI_PACKAGE_NAME) {
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
  return { executable, ...found }
}

function assertSdkModule(value: unknown, sdkEntry: string): PiSdkModule {
  const module = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const sessionManager = module.SessionManager && typeof module.SessionManager === 'function'
    ? module.SessionManager as unknown as Record<string, unknown>
    : module.SessionManager && typeof module.SessionManager === 'object'
      ? module.SessionManager as Record<string, unknown>
      : {}
  if (
    typeof module.createAgentSession !== 'function'
    || typeof sessionManager.create !== 'function'
    || typeof sessionManager.open !== 'function'
  ) {
    throw new Error(`Installed Pi package does not expose the expected official SDK API: ${sdkEntry}`)
  }
  return module as unknown as PiSdkModule
}

export const loadInstalledPiSdk: PiSdkLoader = async explicitExecutable => {
  const executable = await findPiExecutable(explicitExecutable)
  if (!executable) throw new Error('Pi executable was not found in PATH or PI_BIN')
  const discovery = await resolveInstalledPiSdk(executable)
  if (!discovery) {
    throw new Error(
      `Pi was found at ${executable}, but the official ${PI_PACKAGE_NAME} SDK could not be located. `
      + 'Install Pi from its official npm package instead of using the removed AgentLens RPC fallback.',
    )
  }
  const imported = await import(pathToFileURL(discovery.sdkEntry).href)
  return {
    ...discovery,
    module: assertSdkModule(imported, discovery.sdkEntry),
  }
}
