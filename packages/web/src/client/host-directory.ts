import { translateProduct } from '../i18n/runtime'

interface HostDirectorySelection {
  workspacePath: string | null
}

/** Product-level directory selection bridge; no Agent-specific route is exposed to callers. */
export async function selectHostProjectDirectory(): Promise<string | undefined> {
  const response = await fetch('/api/v1/live/project-directory', { method: 'POST' })
  if (!response.ok) {
    let message = ''
    try {
      const payload = await response.json() as { message?: unknown }
      if (typeof payload.message === 'string') message = payload.message
    } catch {
      // Use HTTP status below.
    }
    if (response.status === 501) throw new Error(translateProduct('task:center.newTask.pickerUnavailable'))
    throw new Error(message || translateProduct('task:center.newTask.pickerFailed', { status: response.status }))
  }
  const result = await response.json() as HostDirectorySelection
  return result.workspacePath ?? undefined
}

/** Read-only host check. The browser cannot validate the daemon's filesystem directly. */
export async function validateHostProjectDirectory(workspacePath: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/v1/live/project-directory/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
    signal,
  })
  if (response.ok) return

  let message = ''
  try {
    const payload = await response.json() as { message?: unknown }
    if (typeof payload.message === 'string') message = payload.message
  } catch {
    // Use HTTP status below.
  }
  throw new Error(message || `Directory validation failed (${response.status})`)
}

export interface HostDirectoryListing {
  path: string
  parentPath: string | null
  roots: string[]
  directories: Array<{ name: string; path: string }>
  truncated: boolean
  selectable: boolean
}

/** Browser-only, read-only directory navigation on the running AgentLens host. */
export async function browseHostProjectDirectory(path?: string, signal?: AbortSignal): Promise<HostDirectoryListing> {
  const response = await fetch('/api/v1/live/project-directory/browse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(path ? { path } : {}),
    signal,
  })
  if (!response.ok) {
    let message = ''
    try {
      const payload = await response.json() as { message?: unknown }
      if (typeof payload.message === 'string') message = payload.message
    } catch { /* Use the HTTP status below. */ }
    throw new Error(message || `Directory browsing failed (${response.status})`)
  }
  return await response.json() as HostDirectoryListing
}
