import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { HookManagerOptions } from '@agent-lens/hook-manager'
import { registerInstallationSync, type InstallationKind, type InstallationRecord } from './installations'

export interface HookExecutionProfile {
  options: HookManagerOptions
  windowsNoWindow: boolean
  dispatcherPath?: string
  /** 兼容上一轮 doctor 字段；现在它实际指向共享分发器。 */
  runnerPath?: string
  installation?: InstallationRecord
}

interface ResolveHookExecutionOptions {
  version?: string
  moduleUrl?: string
  platform?: NodeJS.Platform
  nodePath?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

function commandQuote(value: string): string {
  return `"${value}"`
}

function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
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

export function posixDesktopHookCommand(executable: string, scriptPath: string): string {
  return `env ELECTRON_RUN_AS_NODE=1 ${posixQuote(executable)} ${posixQuote(scriptPath)}`
}

function sharedDispatcherPath(homeDir = homedir()): string {
  return join(homeDir, '.agent-lens', '1.0', 'runtime', 'windows-hook-dispatcher.ps1')
}

function installSharedDispatcherSync(source: string, target: string): void {
  const content = readFileSync(source, 'utf8')
  try {
    if (readFileSync(target, 'utf8') === content) return
  } catch {
    // Install below.
  }
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, target)
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
  formalDistribution: boolean
} {
  const current = fileURLToPath(moduleUrl)
  const desktop = env.AGENT_LENS_DISTRIBUTION === 'desktop'
  const formalDistribution = current.endsWith('.mjs') || desktop
  const distRoot = current.endsWith('.mjs')
    ? dirname(current)
    : resolve(dirname(current), '../../../dist')
  const kind: InstallationKind = desktop ? 'desktop' : 'npm'
  return {
    kind,
    executable: env.AGENT_LENS_INSTALLATION_EXECUTABLE || nodePath,
    hooksRoot: env.AGENT_LENS_HOOK_ROOT || join(distRoot, 'hooks'),
    electronRunAsNode: desktop,
    formalDistribution,
  }
}

export function resolveHookExecutionProfile(options: ResolveHookExecutionOptions = {}): HookExecutionProfile {
  const version = options.version ?? process.env.AGENT_LENS_VERSION ?? '1.0.0-alpha.0'
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const platform = options.platform ?? process.platform
  const nodePath = options.nodePath ?? process.execPath
  const env = options.env ?? process.env
  const context = distributionContext(moduleUrl, nodePath, env)
  const codexScript = join(context.hooksRoot, 'agent-lens-hook-codex.mjs')
  const claudeScript = join(context.hooksRoot, 'agent-lens-hook-claude.mjs')
  const dispatcherSource = join(context.hooksRoot, 'windows-hook-dispatcher.ps1')

  let installation: InstallationRecord | undefined
  if (context.formalDistribution && [context.executable, context.hooksRoot, codexScript, claudeScript].every(existsSync)) {
    installation = registerInstallationSync({
      kind: context.kind,
      version,
      executable: context.executable,
      hookRoot: context.hooksRoot,
      electronRunAsNode: context.electronRunAsNode,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    })
  }

  if (platform !== 'win32') {
    const desktopCommands = context.kind === 'desktop' && installation
      ? {
          codexCommand: posixDesktopHookCommand(context.executable, codexScript),
          claudeCommand: posixDesktopHookCommand(context.executable, claudeScript),
        }
      : {}
    return {
      options: desktopCommands,
      windowsNoWindow: false,
      ...(installation ? { installation } : {}),
    }
  }

  const dispatcherPath = sharedDispatcherPath(options.homeDir)
  if (!installation || !existsSync(dispatcherSource)) {
    return {
      options: {},
      windowsNoWindow: false,
      dispatcherPath,
      runnerPath: dispatcherPath,
      ...(installation ? { installation } : {}),
    }
  }

  installSharedDispatcherSync(dispatcherSource, dispatcherPath)
  return {
    options: {
      codexCommand: windowsDispatcherCommand(dispatcherPath, 'codex'),
      claudeCommand: windowsDispatcherCommand(dispatcherPath, 'claude'),
    },
    windowsNoWindow: true,
    dispatcherPath,
    runnerPath: dispatcherPath,
    installation,
  }
}

export const hookExecutionInternals = {
  sharedDispatcherPath,
  distributionContext,
  installSharedDispatcherSync,
}
