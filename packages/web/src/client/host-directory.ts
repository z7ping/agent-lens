interface HostDirectorySelection {
  cwd: string | null
}

/**
 * Product-level directory selection bridge.
 * The legacy endpoint remains behind this client while Surface/Desktop migrate
 * to the Agent-neutral host route; callers must not depend on Pi Live.
 */
export async function selectHostProjectDirectory(): Promise<string | undefined> {
  const response = await fetch('/api/v1/pi-live/project-directory', { method: 'POST' })
  if (!response.ok) {
    let message = ''
    try {
      const payload = await response.json() as { message?: unknown }
      if (typeof payload.message === 'string') message = payload.message
    } catch {
      // Use HTTP status below.
    }
    throw new Error(message || `Directory selection failed (${response.status})`)
  }
  const result = await response.json() as HostDirectorySelection
  return result.cwd ?? undefined
}
