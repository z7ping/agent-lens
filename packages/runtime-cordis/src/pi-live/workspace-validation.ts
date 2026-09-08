import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

function workspaceError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

export async function validatePiLiveWorkspace(cwd: string): Promise<string> {
  const trimmed = cwd.trim()
  if (!trimmed) throw workspaceError('Pi Live 需要有效的工作目录')

  const workspacePath = resolve(trimmed)
  try {
    const workspaceStat = await stat(workspacePath)
    if (!workspaceStat.isDirectory()) {
      throw workspaceError(`Pi Live 工作目录不是文件夹：${workspacePath}`)
    }
    await access(workspacePath, constants.R_OK)
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') throw workspaceError(`Pi Live 工作目录不存在：${workspacePath}`)
    if (code === 'EACCES' || code === 'EPERM') throw workspaceError(`Pi Live 无权访问工作目录：${workspacePath}`)
    const detail = error instanceof Error ? error.message : String(error)
    throw workspaceError(`Pi Live 无法访问工作目录：${workspacePath}（${detail.replace(/[\r\n]+/g, ' ')}）`)
  }

  return workspacePath
}
