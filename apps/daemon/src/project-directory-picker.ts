import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

async function selectWindowsDirectory(): Promise<string | undefined> {
  const script = [
    '$shell = New-Object -ComObject Shell.Application',
    "$folder = $shell.BrowseForFolder(0, '选择新项目目录', 0x51, 0)",
    'if ($null -ne $folder) { [Console]::Out.Write($folder.Self.Path) }',
  ].join('; ')
  const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return selectedPath(result.stdout)
}

async function selectMacDirectory(): Promise<string | undefined> {
  try {
    const result = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择新项目目录")'], { encoding: 'utf8' })
    return selectedPath(result.stdout)
  } catch (error) {
    if (wasCancelled(error)) return undefined
    throw error
  }
}

async function selectLinuxDirectory(): Promise<string | undefined> {
  const pickers: Array<readonly [string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', '--title=选择新项目目录']],
    ['kdialog', ['--getexistingdirectory', '.', '--title', '选择新项目目录']],
  ]
  let unavailable: unknown
  for (const [command, args] of pickers) {
    try {
      const result = await execFileAsync(command, args, { encoding: 'utf8' })
      return selectedPath(result.stdout)
    } catch (error) {
      if (wasCancelled(error)) return undefined
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
        unavailable = error
        continue
      }
      throw error
    }
  }
  throw new Error(`当前 Linux 环境没有可用的系统目录选择器（需要 zenity 或 kdialog）。${unavailable ? '请安装其中之一后重试。' : ''}`)
}

export function createProjectDirectoryPicker(platform = process.platform): ProjectDirectoryPicker {
  const picker = platform === 'win32'
    ? selectWindowsDirectory
    : platform === 'darwin'
      ? selectMacDirectory
      : platform === 'linux'
        ? selectLinuxDirectory
        : async () => { throw new Error(`当前系统暂不支持原生目录选择：${platform}`) }
  let pending: Promise<string | undefined> | null = null
  return {
    select() {
      if (pending) return pending
      pending = picker().finally(() => { pending = null })
      return pending
    },
  }
}
