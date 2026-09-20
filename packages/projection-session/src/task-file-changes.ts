import type {
  CanonicalObservation,
  TaskFileChangeCandidate,
} from '@agent-lens/core'

type RecordValue = Record<string, unknown>

interface MutationIntent {
  callId?: string
  paths: Array<{
    path: string
    oldPath?: string
    operation: TaskFileChangeCandidate['operation']
  }>
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringField(value: RecordValue, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = text(value[key])
    if (candidate) return candidate
  }
  return undefined
}

function normalizedToolName(payload: RecordValue): string {
  return (stringField(payload, 'nativeToolName', 'toolName', 'tool_name', 'name') ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
}

function callId(payload: RecordValue): string | undefined {
  return stringField(payload, 'callId', 'call_id', 'toolUseId', 'tool_use_id')
}

function mutationPath(input: RecordValue): string | undefined {
  return stringField(input, 'path', 'file_path', 'filePath', 'filename', 'file')
}

const WRITE_TOOLS = new Set([
  'edit',
  'edit_file',
  'write',
  'write_file',
  'create_file',
  'replace',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'multi_edit',
])

const DELETE_TOOLS = new Set([
  'delete_file',
  'remove_file',
  'unlink_file',
])

const RENAME_TOOLS = new Set([
  'rename_file',
  'move_file',
])

const PATCH_TOOLS = new Set([
  'apply_patch',
  'patch',
])

const SHELL_TOOLS = new Set([
  'bash',
  'sh',
  'shell',
  'terminal',
  'exec',
  'execute',
  'command',
  'run_command',
])

function normalizePatchPath(value: string): string | undefined {
  const normalized = value.trim().replace(/^["']|["']$/g, '')
  if (!normalized || normalized === '/dev/null') return undefined
  return normalized.replace(/^[ab]\//, '')
}

export function patchMutationPaths(value: string): MutationIntent['paths'] {
  const result: MutationIntent['paths'] = []
  const seen = new Set<string>()
  let pendingMoveFrom: string | undefined

  const push = (
    path: string | undefined,
    operation: TaskFileChangeCandidate['operation'],
    oldPath?: string,
  ) => {
    if (!path) return
    const key = `${operation}\u0000${oldPath ?? ''}\u0000${path}`
    if (seen.has(key)) return
    seen.add(key)
    result.push({ path, ...(oldPath ? { oldPath } : {}), operation })
  }

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/)
    if (add) {
      push(normalizePatchPath(add[1]!), 'write')
      pendingMoveFrom = undefined
      continue
    }
    const update = line.match(/^\*\*\* Update File:\s*(.+)$/)
    if (update) {
      pendingMoveFrom = normalizePatchPath(update[1]!)
      push(pendingMoveFrom, 'write')
      continue
    }
    const remove = line.match(/^\*\*\* Delete File:\s*(.+)$/)
    if (remove) {
      push(normalizePatchPath(remove[1]!), 'delete')
      pendingMoveFrom = undefined
      continue
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/)
    if (move && pendingMoveFrom) {
      const destination = normalizePatchPath(move[1]!)
      if (destination) {
        const previousWrite = result.findIndex(item =>
          item.operation === 'write' && item.path === pendingMoveFrom
        )
        if (previousWrite >= 0) result.splice(previousWrite, 1)
        push(destination, 'rename', pendingMoveFrom)
      }
      pendingMoveFrom = undefined
      continue
    }
  }

  if (result.length) return result

  // Fallback for ordinary unified diffs. This only identifies touched paths;
  // final A/M/D/R classification belongs to Git/filesystem reconciliation.
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue
    const candidate = normalizePatchPath(line.slice(4).split(/\s+/)[0] ?? '')
    if (candidate) push(candidate, 'write')
  }
  return result
}

export function toolMutationIntent(observation: CanonicalObservation): MutationIntent | undefined {
  if (observation.kind !== 'tool.call') return undefined
  const payload = record(observation.payload)
  const name = normalizedToolName(payload)
  if (!name || SHELL_TOOLS.has(name)) return undefined
  const input = record(payload.input)

  if (PATCH_TOOLS.has(name)) {
    const patch = stringField(input, 'patch', 'diff', 'content', 'input')
      ?? stringField(payload, 'patch', 'diff')
    const paths = patch ? patchMutationPaths(patch) : []
    return paths.length ? { ...(callId(payload) ? { callId: callId(payload) } : {}), paths } : undefined
  }

  if (RENAME_TOOLS.has(name)) {
    const oldPath = stringField(input, 'old_path', 'oldPath', 'from', 'source', 'path')
    const path = stringField(input, 'new_path', 'newPath', 'to', 'destination')
    if (!oldPath || !path) return undefined
    return {
      ...(callId(payload) ? { callId: callId(payload) } : {}),
      paths: [{ path, oldPath, operation: 'rename' }],
    }
  }

  const path = mutationPath(input)
  if (!path) return undefined
  if (DELETE_TOOLS.has(name)) {
    return {
      ...(callId(payload) ? { callId: callId(payload) } : {}),
      paths: [{ path, operation: 'delete' }],
    }
  }
  if (WRITE_TOOLS.has(name)) {
    return {
      ...(callId(payload) ? { callId: callId(payload) } : {}),
      paths: [{ path, operation: 'write' }],
    }
  }
  return undefined
}

function resultSucceeded(observation: CanonicalObservation): boolean | undefined {
  if (observation.kind !== 'tool.result') return undefined
  const payload = record(observation.payload)
  const explicitError = payload.error
  if (explicitError === true) return false
  const status = stringField(payload, 'status')
  if (status === 'error' || status === 'failed' || status === 'failure') return false
  if (status === 'success' || status === 'completed' || status === 'ok') return true
  if (explicitError === false) return true
  // Canonical Review already treats a tool.result as successful unless the
  // normalized payload carries an error signal.
  return true
}

function effectiveAt(observation: CanonicalObservation): string {
  return observation.occurredAt ?? observation.capturedAt
}

export function observedTaskFileChanges(
  observations: readonly CanonicalObservation[],
): TaskFileChangeCandidate[] {
  const pendingByCall = new Map<string, { observation: CanonicalObservation; intent: MutationIntent }>()
  const unkeyed: Array<{ observation: CanonicalObservation; intent: MutationIntent }> = []
  const result: TaskFileChangeCandidate[] = []

  const emit = (observation: CanonicalObservation, intent: MutationIntent) => {
    for (const item of intent.paths) {
      result.push({
        logicalSessionId: observation.logicalSessionId,
        observationId: observation.id,
        path: item.path,
        ...(item.oldPath ? { oldPath: item.oldPath } : {}),
        operation: item.operation,
        observedAt: effectiveAt(observation),
        evidence: 'tool',
        confidence: 'medium',
      })
    }
  }

  for (const observation of observations) {
    const intent = toolMutationIntent(observation)
    if (intent) {
      if (intent.callId) pendingByCall.set(intent.callId, { observation, intent })
      else unkeyed.push({ observation, intent })
      continue
    }

    if (observation.kind !== 'tool.result') continue
    const payload = record(observation.payload)
    const id = callId(payload)
    if (!id) continue
    const pending = pendingByCall.get(id)
    if (!pending) continue
    pendingByCall.delete(id)
    if (resultSucceeded(observation)) emit(pending.observation, pending.intent)
  }

  // Some native protocols do not persist a stable call id/result pair. Keep
  // explicit mutating tool calls as observed evidence, never as exact Git truth.
  for (const pending of unkeyed) emit(pending.observation, pending.intent)

  return result.sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt)
    || left.path.localeCompare(right.path)
    || left.observationId.localeCompare(right.observationId)
  )
}
