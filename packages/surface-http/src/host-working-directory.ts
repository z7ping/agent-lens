import { access, constants as fsConstants, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { httpError } from './http-utils'

/**
 * Live 在 HTTP Runtime 所在的主机启动；cwd 必须是可读写的绝对目录。
 * 在创建 Runtime 前完成校验，避免把一个必然失败的输入显示成“启动中”。
 */
export async function validateHostWorkingDirectory(cwd: string): Promise<string> {
  const normalized = cwd.trim()
  if (!isAbsolute(normalized)) {
    throw httpError(400, '项目目录必须是运行 AgentLens 的这台计算机上的绝对路径。')
  }
  try {
    const metadata = await stat(normalized)
    if (!metadata.isDirectory()) {
      throw httpError(400, `项目路径不是目录：${normalized}`)
    }
    await access(normalized, fsConstants.R_OK | fsConstants.W_OK)
    return normalized
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : ''
    if (code === 'ENOENT') throw httpError(400, `找不到项目目录：${normalized}`)
    if (code === 'ENOTDIR') throw httpError(400, `项目路径不是目录：${normalized}`)
    throw httpError(400, `项目目录不可读写：${normalized}。请检查路径和访问权限。`)
  }
}

