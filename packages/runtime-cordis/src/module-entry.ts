import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function canonicalPath(path: string): string {
  try { return realpathSync.native(path) }
  catch { return resolve(path) }
}

/** Node 会解析模块的符号链接；启动路径也须按同一文件身份比较。 */
export function isDirectInvocation(
  moduleUrl: string,
  invokedPath: string | undefined,
  canonicalize: (path: string) => string = canonicalPath,
): boolean {
  return Boolean(invokedPath)
    && canonicalize(fileURLToPath(moduleUrl)) === canonicalize(resolve(invokedPath!))
}
