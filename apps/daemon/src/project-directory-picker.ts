import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const NATIVE_PICKER_TIMEOUT_MS = 2 * 60_000

export class ProjectDirectoryPickerError extends Error {
  readonly statusCode = 503

  constructor(message: string) {
    super(message)
    this.name = 'ProjectDirectoryPickerError'
  }
}

export interface ProjectDirectoryPicker {
  select(): Promise<string | undefined>
}

function selectedPath(value: string): string | undefined {
  const path = value.trim()
  return path || undefined
}

function wasCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:-128|cancel(?:led)?)/i.test(message)
}

function wasTimedOut(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed?\s*out|timeout/i.test(message)
}

function missingCommand(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT')
}

function isEmptyExitCancellation(error: unknown, exitCode: number | undefined): boolean {
  if (exitCode === undefined || !error || typeof error !== 'object' || Reflect.get(error, 'code') !== exitCode) return false
  const stderr = Reflect.get(error, 'stderr')
  return typeof stderr !== 'string' || !stderr.trim()
}

async function runNativePicker(command: string, args: string[], platform: string, options: { windowsHide?: boolean; cancelExitCode?: number } = {}): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: NATIVE_PICKER_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      ...options,
    })
    return selectedPath(result.stdout)
  } catch (error) {
    if (wasCancelled(error) || isEmptyExitCancellation(error, options.cancelExitCode)) return undefined
    if (wasTimedOut(error)) throw new ProjectDirectoryPickerError('目录选择已超时，请重新打开后再试。')
    if (missingCommand(error)) throw new ProjectDirectoryPickerError(`当前 ${platform} 环境没有可用的系统目录选择器。`)
    throw new ProjectDirectoryPickerError(`无法打开 ${platform} 系统目录选择器：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function selectWindowsDirectory(): Promise<string | undefined> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择新项目目录'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  ].join('; ')
  // 保持宿主控制台最小化而不是隐藏，否则 Windows 会把随后的目录框一并
  // 放到不可见桌面。目录框本身继续前台可操作。
  return runNativePicker('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Minimized', '-Command', script], 'Windows', { windowsHide: false })
}

async function selectMacDirectory(): Promise<string | undefined> {
  return runNativePicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择新项目目录")'], 'macOS')
}

async function selectLinuxDirectory(): Promise<string | undefined> {
  const pickers: Array<readonly [string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', '--title=选择新项目目录']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', '选择新项目目录']],
  ]
  let unavailable: unknown
  for (const [command, args] of pickers) {
    try {
      return await runNativePicker(command, args, 'Linux', { cancelExitCode: 1 })
    } catch (error) {
      if (missingCommand(error) || error instanceof ProjectDirectoryPickerError && /没有可用的系统目录选择器/.test(error.message)) {
        unavailable = error
        continue
      }
      throw error
    }
  }
  throw new ProjectDirectoryPickerError(`当前 Linux 环境没有可用的系统目录选择器（需要 zenity 或 kdialog）。${unavailable ? '请安装其中之一后重试。' : ''}`)
}

export function createProjectDirectoryPicker(
  platform = process.platform,
  selectOverride?: () => Promise<string | undefined>,
): ProjectDirectoryPicker {
  const picker = platform === 'win32'
    ? selectWindowsDirectory
    : platform === 'darwin'
      ? selectMacDirectory
      : platform === 'linux'
        ? selectLinuxDirectory
        : async () => { throw new Error(`当前系统暂不支持原生目录选择：${platform}`) }
  const select = selectOverride ?? picker
  let pending: Promise<string | undefined> | null = null
  return {
    select() {
      if (pending) return pending
      pending = select().finally(() => { pending = null })
      return pending
    },
  }
}
