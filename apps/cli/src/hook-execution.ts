import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HookManagerOptions } from '@agent-lens/hook-manager'

export interface HookExecutionProfile {
  options: HookManagerOptions
  windowsNoWindow: boolean
  runnerPath?: string
}

function commandQuote(value: string): string {
  return `"${value}"`
}

export function windowsHookCommand(nodePath: string, runnerPath: string, hookScript: string): string {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle Hidden',
    '-ExecutionPolicy Bypass',
    '-File', commandQuote(runnerPath),
    commandQuote(nodePath),
    commandQuote(hookScript),
  ].join(' ')
}

export function resolveHookExecutionProfile(
  moduleUrl = import.meta.url,
  platform: NodeJS.Platform = process.platform,
  nodePath = process.execPath,
): HookExecutionProfile {
  if (platform !== 'win32') return { options: {}, windowsNoWindow: false }

  const current = fileURLToPath(moduleUrl)
  const distRoot = current.endsWith('.mjs')
    ? dirname(current)
    : resolve(dirname(current), '../../../dist')
  const hooksRoot = join(distRoot, 'hooks')
  const runnerPath = join(hooksRoot, 'agent-lens-hook-runner.ps1')
  const codexScript = join(hooksRoot, 'agent-lens-hook-codex.mjs')
  const claudeScript = join(hooksRoot, 'agent-lens-hook-claude.mjs')

  if (![runnerPath, codexScript, claudeScript].every(existsSync)) {
    return { options: {}, windowsNoWindow: false, runnerPath }
  }

  return {
    options: {
      codexCommand: windowsHookCommand(nodePath, runnerPath, codexScript),
      claudeCommand: windowsHookCommand(nodePath, runnerPath, claudeScript),
    },
    windowsNoWindow: true,
    runnerPath,
  }
}
