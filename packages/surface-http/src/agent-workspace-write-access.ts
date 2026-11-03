import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface WorkspaceWriteScope {
  sourceId: string
  installationId: string
  root: string
}

export interface WorkspaceWriteAccess {
  /** Independent from Source-enabled and Live permissions; default deny. */
  allowed(scope: WorkspaceWriteScope): boolean
  set(scope: WorkspaceWriteScope, enabled: boolean): Promise<boolean>
}

type Grant = WorkspaceWriteScope

function validScope(scope: WorkspaceWriteScope): boolean {
  return Boolean(
    scope.sourceId && /^[a-zA-Z0-9_-]{1,80}$/.test(scope.sourceId)
    && scope.installationId && scope.installationId.length <= 256
    && !/[\x00-\x1f]/.test(scope.installationId)
    && isAbsolute(scope.root),
  )
}
function normalize(scope: WorkspaceWriteScope): Grant {
  if (!validScope(scope)) throw new Error('Invalid native workspace permission scope')
  return { sourceId: scope.sourceId, installationId: scope.installationId, root: resolve(scope.root) }
}
function grantKey(scope: Grant): string {
  return JSON.stringify([scope.sourceId, scope.installationId])
}

/** Local AgentLens product preference, deliberately NOT a Hermes native-data write. */
export async function createWorkspaceWriteAccess(path: string): Promise<WorkspaceWriteAccess> {
  if (!isAbsolute(path)) throw new Error('Workspace write permission path must be absolute')
  const grants = new Map<string, Grant>()
  try {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid workspace permission format')
    const data = json as { version?: unknown; grants?: unknown }
    if (data.version !== 1 || !Array.isArray(data.grants) || data.grants.length > 1000) {
      throw new Error('Unsupported workspace permission format')
    }
    for (const raw of data.grants) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid workspace grant')
      const grant = normalize(raw as Grant)
      grants.set(grantKey(grant), grant)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Fail closed rather than losing existing grants or overwriting damaged state.
      throw new Error('Workspace write permission file cannot be loaded', { cause: error })
    }
  }

  let writes: Promise<void> = Promise.resolve()
  return {
    allowed(scope) {
      if (!validScope(scope)) return false
      const candidate = normalize(scope)
      return grants.get(grantKey(candidate))?.root === candidate.root
    },
    set(scope, enabled) {
      const candidate = normalize(scope)
      const update = writes.catch(() => {}).then(async () => {
        const next = new Map(grants)
        if (enabled) next.set(grantKey(candidate), candidate)
        else next.delete(grantKey(candidate))
        const body = JSON.stringify({ version: 1, grants: [...next.values()] }, null, 2) + '\n'
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temp = path + '.' + randomUUID() + '.tmp'
        try {
          await writeFile(temp, body, { mode: 0o600, flag: 'wx' })
          await rename(temp, path)
        } finally {
          await rm(temp, { force: true }).catch(() => {})
        }
        grants.clear()
        for (const [key, value] of next) grants.set(key, value)
      })
      writes = update
      return update.then(() => enabled)
    },
  }
}
