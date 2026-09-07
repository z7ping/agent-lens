import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

export interface HttpStaticMount {
  id: string
  directory: string
  spaFallback?: boolean
}
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

function safeFilePath(root: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/, '')
  const fullPath = resolve(root, relative)
  if (fullPath === root || fullPath.startsWith(`${root}${sep}`)) return fullPath
  return null
}

async function tryServeFile(response: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    const content = await readFile(filePath)
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    response.statusCode = 200
    response.setHeader('content-type', contentType)
    response.setHeader('cache-control', 'no-cache')
    response.setHeader('content-length', content.byteLength)
    response.end(content)
    return true
  } catch {
    return false
  }
}

export async function handleStatic(
  response: ServerResponse,
  pathname: string,
  mounts: Iterable<HttpStaticMount>,
): Promise<boolean> {
  for (const mount of mounts) {
    const root = resolve(mount.directory)
    const requestedPath = pathname === '/' ? 'index.html' : pathname
    const candidate = safeFilePath(root, requestedPath)
    if (candidate && await tryServeFile(response, candidate)) return true

    if (mount.spaFallback && !extname(pathname)) {
      const indexPath = safeFilePath(root, 'index.html')
      if (indexPath && await tryServeFile(response, indexPath)) return true
    }
  }
  return false
}
