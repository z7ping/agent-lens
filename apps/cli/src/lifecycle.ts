import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

const WINDOWS_TASK_NAME = 'AgentLens Background'
const LINUX_UNIT_NAME = 'agent-lens.service'
const MAC_LABEL = 'com.agentlens.daemon'

export interface LifecycleOptions {
  cliEntry: string
  nodePath?: string
  homeDir?: string
  platform?: NodeJS.Platform
}

export interface LifecycleStatus {
  manager: 'windows-task-scheduler' | 'systemd-user' | 'launchd-user'
  registered: boolean
  active: boolean
  autostart: boolean
  detail?: string
}

interface LifecyclePreferences {
  version: 1
  autostart: boolean
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function dataRoot(homeDir = homedir()): string {
  return join(homeDir, '.agent-lens', '1.0')
}

function runtimeDir(homeDir = homedir()): string {
  return join(dataRoot(homeDir), 'runtime')
}

function preferencesPath(homeDir = homedir()): string {
  return join(runtimeDir(homeDir), 'lifecycle.json')
}

async function readPreferences(homeDir?: string): Promise<LifecyclePreferences> {
  try {
    const parsed = JSON.parse(await readFile(preferencesPath(homeDir), 'utf8')) as Partial<LifecyclePreferences>
    return { version: 1, autostart: parsed.autostart === true }
  } catch {
    return { version: 1, autostart: false }
  }
}

async function writePreferences(preferences: LifecyclePreferences, homeDir?: string): Promise<void> {
  const dir = runtimeDir(homeDir)
  await mkdir(dir, { recursive: true })
  const target = preferencesPath(homeDir)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

async function runChecked(command: string, args: string[], label: string): Promise<CommandResult> {
  const result = await run(command, args)
  if (result.code !== 0) throw new Error(`${label}失败${result.stderr ? `：${result.stderr}` : ''}`)
  return result
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function windowsTaskScript(options: LifecycleOptions, autostart: boolean): string {
  const nodePath = options.nodePath ?? process.execPath
  const argument = `"${options.cliEntry}" service run`
  return [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = ${psQuote(WINDOWS_TASK_NAME)}`,
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(argument)}`,
    '$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    autostart
      ? '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\nRegister-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Trigger $trigger -Description \'AgentLens 用户级后台运行时\' -Force | Out-Null'
      : 'Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Principal $principal -Description \'AgentLens 用户级后台运行时\' -Force | Out-Null',
  ].join('\n')
}

function windowsStatusScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { [pscustomobject]@{ registered = $false; active = $false; autostart = $false; state = 'Missing' } | ConvertTo-Json -Compress; exit 0 }",
    "$hasLogon = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled }).Count -gt 0",
    '[pscustomobject]@{ registered = $true; active = ($task.State -eq \'Running\'); autostart = $hasLogon; state = [string]$task.State } | ConvertTo-Json -Compress',
  ].join('\n')
}

async function powershell(script: string): Promise<CommandResult> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

async function ensureWindowsDefinition(options: LifecycleOptions, autostart: boolean): Promise<void> {
  await runChecked('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsTaskScript(options, autostart),
  ], '注册 Windows 后台任务')
}

async function windowsStatus(): Promise<LifecycleStatus> {
  const result = await powershell(windowsStatusScript())
  if (result.code !== 0) throw new Error(`读取 Windows 后台任务状态失败${result.stderr ? `：${result.stderr}` : ''}`)
  const parsed = JSON.parse(result.stdout || '{}') as { registered?: boolean; active?: boolean; autostart?: boolean; state?: string }
  return {
    manager: 'windows-task-scheduler',
    registered: parsed.registered === true,
    active: parsed.active === true,
    autostart: parsed.autostart === true,
    detail: parsed.state,
  }
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function systemdUnit(options: LifecycleOptions): string {
  const nodePath = options.nodePath ?? process.execPath
  return [
    '[Unit]',
    'Description=AgentLens user background runtime',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(nodePath)} ${systemdQuote(options.cliEntry)} service run`,
    `WorkingDirectory=${systemdQuote(dirname(options.cliEntry))}`,
    'Restart=on-failure',
    'RestartSec=2',
    'KillMode=control-group',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function linuxUnitPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.config', 'systemd', 'user', LINUX_UNIT_NAME)
}

async function ensureLinuxDefinition(options: LifecycleOptions): Promise<void> {
  const path = linuxUnitPath(options.homeDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, systemdUnit(options), 'utf8')
  await runChecked('systemctl', ['--user', 'daemon-reload'], '刷新 systemd 用户服务')
}

async function linuxStatus(options: LifecycleOptions): Promise<LifecycleStatus> {
  const registered = existsSync(linuxUnitPath(options.homeDir))
  if (!registered) return { manager: 'systemd-user', registered: false, active: false, autostart: false, detail: 'missing' }
  const [active, enabled] = await Promise.all([
    run('systemctl', ['--user', 'is-active', LINUX_UNIT_NAME]),
    run('systemctl', ['--user', 'is-enabled', LINUX_UNIT_NAME]),
  ])
  return {
    manager: 'systemd-user',
    registered: true,
    active: active.code === 0 && active.stdout === 'active',
    autostart: enabled.code === 0 && enabled.stdout === 'enabled',
    detail: active.stdout || active.stderr || 'unknown',
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function launchdPlist(options: LifecycleOptions, autostart: boolean): string {
  const home = options.homeDir ?? homedir()
  const logs = runtimeDir(home)
  const nodePath = options.nodePath ?? process.execPath
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MAC_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(options.cliEntry)}</string>`,
    '    <string>service</string>',
    '    <string>run</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(dirname(options.cliEntry))}</string>`,
    '  <key>RunAtLoad</key>',
    autostart ? '  <true/>' : '  <false/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(join(logs, 'service.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(join(logs, 'service-error.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function macPlistPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)
}

function macTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `gui/${uid}/${MAC_LABEL}`
}

function macDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `gui/${uid}`
}

async function ensureMacDefinition(options: LifecycleOptions, autostart: boolean): Promise<void> {
  const path = macPlistPath(options.homeDir)
  await mkdir(dirname(path), { recursive: true })
  await mkdir(runtimeDir(options.homeDir), { recursive: true })
  await writeFile(path, launchdPlist(options, autostart), 'utf8')
}

async function macStatus(options: LifecycleOptions): Promise<LifecycleStatus> {
  const registered = existsSync(macPlistPath(options.homeDir))
  if (!registered) return { manager: 'launchd-user', registered: false, active: false, autostart: false, detail: 'missing' }
  const preferences = await readPreferences(options.homeDir)
  const result = await run('launchctl', ['print', macTarget()])
  return {
    manager: 'launchd-user',
    registered: true,
    active: result.code === 0 && /state\s*=\s*running/.test(result.stdout),
    autostart: preferences.autostart,
    detail: result.code === 0 ? (result.stdout.match(/state\s*=\s*([^\n]+)/)?.[1]?.trim() ?? 'loaded') : 'not loaded',
  }
}

function platformOf(options: LifecycleOptions): NodeJS.Platform {
  return options.platform ?? process.platform
}

function assertSupported(platform: NodeJS.Platform): asserts platform is 'win32' | 'linux' | 'darwin' {
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`当前平台暂不支持 npm 后台生命周期：${platform}`)
  }
}

export async function getLifecycleStatus(options: LifecycleOptions): Promise<LifecycleStatus> {
  const platform = platformOf(options)
  assertSupported(platform)
  if (platform === 'win32') return windowsStatus()
  if (platform === 'linux') return linuxStatus(options)
  return macStatus(options)
}

async function ensureDefinition(options: LifecycleOptions, autostart: boolean): Promise<void> {
  const platform = platformOf(options)
  assertSupported(platform)
  if (platform === 'win32') return ensureWindowsDefinition(options, autostart)
  if (platform === 'linux') return ensureLinuxDefinition(options)
  return ensureMacDefinition(options, autostart)
}

export async function setAutostart(enabled: boolean, options: LifecycleOptions): Promise<LifecycleStatus> {
  const platform = platformOf(options)
  assertSupported(platform)
  await writePreferences({ version: 1, autostart: enabled }, options.homeDir)
  await ensureDefinition(options, enabled)
  if (platform === 'linux') {
    await runChecked('systemctl', ['--user', enabled ? 'enable' : 'disable', LINUX_UNIT_NAME], `${enabled ? '启用' : '关闭'}开机自启`)
  }
  return getLifecycleStatus(options)
}

export async function serviceStart(options: LifecycleOptions): Promise<LifecycleStatus> {
  const platform = platformOf(options)
  assertSupported(platform)
  const preferences = await readPreferences(options.homeDir)
  await ensureDefinition(options, preferences.autostart)
  if (platform === 'win32') {
    await runChecked('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Start-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)}`], '启动 Windows 后台任务')
  } else if (platform === 'linux') {
    await runChecked('systemctl', ['--user', 'start', LINUX_UNIT_NAME], '启动 systemd 用户服务')
  } else {
    const current = await run('launchctl', ['print', macTarget()])
    if (current.code !== 0) {
      await runChecked('launchctl', ['bootstrap', macDomain(), macPlistPath(options.homeDir)], '加载 launchd 用户服务')
    }
    await runChecked('launchctl', ['kickstart', '-k', macTarget()], '启动 launchd 用户服务')
  }
  return getLifecycleStatus(options)
}

export async function serviceStop(options: LifecycleOptions): Promise<LifecycleStatus> {
  const platform = platformOf(options)
  assertSupported(platform)
  const current = await getLifecycleStatus(options)
  if (!current.registered) return current
  if (platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Stop-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`])
  } else if (platform === 'linux') {
    await run('systemctl', ['--user', 'stop', LINUX_UNIT_NAME])
  } else {
    await run('launchctl', ['bootout', macTarget()])
  }
  return getLifecycleStatus(options)
}

export async function serviceRestart(options: LifecycleOptions): Promise<LifecycleStatus> {
  await serviceStop(options)
  return serviceStart(options)
}

export const lifecycleInternals = {
  dataRoot,
  runtimeDir,
  preferencesPath,
  windowsTaskScript,
  systemdUnit,
  launchdPlist,
  psQuote,
  systemdQuote,
  xmlEscape,
}
