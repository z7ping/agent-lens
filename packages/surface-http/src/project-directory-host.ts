import type { IncomingMessage } from 'node:http'
import { httpError } from './http-utils'

const HOST_PICKER_HEADER = 'x-agent-lens-host-picker'
const HOST_PROJECT_DIRECTORY_HEADER = 'x-agent-lens-host-project-directory'
const PROJECT_DIRECTORY_PICKER = 'project-directory'

export interface HostProjectDirectorySelection {
  handled: boolean
  cwd?: string | undefined
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) throw httpError(400, `${name} must be a single header`)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readHostProjectDirectory(request: IncomingMessage): HostProjectDirectorySelection {
  if (singleHeader(request, HOST_PICKER_HEADER) !== PROJECT_DIRECTORY_PICKER) {
    return { handled: false }
  }

  const encoded = singleHeader(request, HOST_PROJECT_DIRECTORY_HEADER)
  if (!encoded) return { handled: true }

  try {
    const cwd = decodeURIComponent(encoded).trim()
    return cwd ? { handled: true, cwd } : { handled: true }
  } catch {
    throw httpError(400, '桌面宿主返回了无效的项目目录')
  }
}
