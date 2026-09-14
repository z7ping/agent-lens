import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LocalPathOpenAction = 'opened' | 'revealed'

interface OpenCommand {
  command: string
  args: string[]
  action: LocalPathOpenAction
}

export function localPathOpenCommand(
  platform: NodeJS.Platform,
  path: string,
  kind: 'file' | 'directory',
): OpenCommand {
  if (platform === 'win32') {
    return kind === 'file'
      ? { command: 'explorer.exe', args: [`/select,${path}`], action: 'revealed' }
      : { command: 'explorer.exe', args: [path], action: 'opened' }
  }

  if (platform === 'darwin') {
    return kind === 'file'
      ? { command: 'open', args: ['-R', path], action: 'revealed' }
      : { command: 'open', args: [path], action: 'opened' }
  }

  if (platform === 'linux') {
    return {
      command: 'xdg-open',
      args: [kind === 'file' ? dirname(path) : path],
      action: 'opened',
    }
  }

  throw new Error(`当前系统不支持直接定位本地路径：${platform}`)
}

async function launchDetached(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openLocalPath(path: string): Promise<LocalPathOpenAction> {
  const normalized = path.trim()
  if (!normalized) throw new Error('目标路径无效。')

  let metadata
  try {
    metadata = await stat(normalized)
  } catch {
    throw new Error('目标路径不存在或无法访问。')
  }

  const kind = metadata.isFile()
    ? 'file'
    : metadata.isDirectory()
      ? 'directory'
      : null
  if (!kind) throw new Error('当前路径类型不支持在文件管理器中打开。')

  const plan = localPathOpenCommand(process.platform, normalized, kind)
  try {
    await launchDetached(plan.command, plan.args)
  } catch (error) {
    throw new Error(
      `无法打开系统文件管理器：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return plan.action
}
