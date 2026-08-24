import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { HookManagerOptions } from '@agent-lens/hook-manager'
import { registerInstallation, type InstallationKind, type InstallationRecord } from './installations'

export interface HookExecutionProfile {
  options: HookManagerOptions
  windowsNoWindow: boolean
  dispatcherPath?: string
  installation?: InstallationRecord
}

interface PrepareHookExecutionOptions {
  version: string
  moduleUrl?: string
  platform?: NodeJS.Platform
  nodePath?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

function commandQuote(value: string): string {
  return `"${value}"`
}

export function windowsDispatcherCommand(dispatcherPath: string, target: 'codex' | 'claude'): string {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-ExecutionPolicy Bypass',
    '-File', commandQuote(dispatcherPath),
    target === 'codex' ? 'agent-lens-hook-codex' : 'agent-lens-hook-claude',
  ].join(' ')
}

function sharedDispatcherPath(homeDir = homedir()): string {
  return join(homeDir, '.agent-lens', '1.0', 'runtime', 'windows-hook-dispatcher.ps1')
}

async function installSharedDispatcher(source: string, target: string): Promise<void> {
  const content = await readFile(source, 'utf8')
  try {
    if (await readFile(target, 'utf8') === content) return
  } catch {
    // Install below.
  }
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

function distributionContext(
  moduleUrl: string,
  nodePath: string,
  env: NodeJS.ProcessEnv,
): {
  kind: InstallationKind
  executable: string
  hooksRoot: string
  electronRunAsNode: boolean
} {
  const current = fileURLToPath(moduleUrl)
  const distRoot = current.endsWith('.mjs')
    ? dirname(current)
    : resolve(dirname(current), '../../../dist')
  const kind: InstallationKind = env.AGENT_LENS_DISTRIBUTION === 'desktop' ? 'desktop' : 'npm'
  return {
    kind,
    executable: env.AGENT_LENS_INSTALLATION_EXECUTABLE || nodePath,
    hooksRoot: env.AGENT_LENS_HOOK_ROOT || join(distRoot, 'hooks'),
    electronRunAsNode: kind === 'desktop',
  }
}

export async function prepareHookExecutionProfile(options: PrepareHookExecutionOptions): Promise<HookExecutionProfile> {
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const platform = options.platform ?? process.platform
  const nodePath = options.nodePath ?? process.execPath
  const env = options.env ?? process.env
  const context = distributionContext(moduleUrl, nodePath, env)
  const codexScript = join(context.hooksRoot, 'agent-lens-hook-codex.mjs')
  const claudeScript = join(context.hooksRoot, 'agent-lens-hook-claude.mjs')
  const dispatcherSource = join(context.hooksRoot, 'windows-hook-dispatcher.ps1')

  let installation: InstallationRecord | undefined
  if ([context.executable, context.hooksRoot, codexScript, claudeScript].every(existsSync)) {
    installation = await registerInstallation({
      kind: context.kind,
      version: options.version,
      executable: context.executable,
      hookRoot: context.hooksRoot,
      electronRunAsNode: context.electronRunAsNode,
      homeDir: options.homeDir,
    })
  }

  if (platform !== 'win32') return { options: {}, windowsNoWindow: false, installation }

  const dispatcherPath = sharedDispatcherPath(options.homeDir)
  if (!installation || !existsSync(dispatcherSource)) {
    return { options: {}, windowsNoWindow: false, dispatcherPath, installation }
  }

  await installSharedDispatcher(dispatcherSource, dispatcherPath)
  return {
    options: {
      codexCommand: windowsDispatcherCommand(dispatcherPath, 'codex'),
      claudeCommand: windowsDispatcherCommand(dispatcherPath, 'claude'),
    },
    windowsNoWindow: true,
    dispatcherPath,
    installation,
  }
}

export const hookExecutionInternals = {
  sharedDispatcherPath,
  distributionContext,
}
