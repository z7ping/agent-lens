import type { JsonValue, ReviewEventNodeDto, TaskFileChangesResponseDto } from '@agent-lens/protocol'
import { agentLensI18n } from '../i18n/runtime'

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

/** 仅折叠已被集中卡片完整覆盖的成功文件事件，失败或其他产物继续原样展示。 */
export function isConsolidatedFileChangeEvent(event: ReviewEventNodeDto, changes: TaskFileChangesResponseDto | null | undefined): boolean {
  const payload = record(event.payload)
  if (event.kind !== 'artifact.action' || payload.action !== 'file.change' || !changes
    || !['completed', 'success', 'ok'].includes(String(payload.status))) return false
  const paths = Object.keys(record(payload.changes))
  return paths.length > 0 && paths.every(path => changes.items.some(item => item.path === path || item.oldPath === path))
}

function stringValue(value: Record<string, JsonValue>, ...keys: string[]): string {
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (typeof item === 'number') return String(item)
  }
  return ''
}

function artifactFiles(value: JsonValue | undefined): string[] {
  const changes = record(value)
  return Object.keys(changes)
}

function artifactChangeTypes(value: JsonValue | undefined): string[] {
  return Object.values(record(value)).flatMap(change => {
    const type = stringValue(record(change), 'type').toLowerCase()
    return type ? [type] : []
  })
}

/**
 * 将来源的产物事件翻译为用户可读的动作。路径仍由 Review 的本地资源组件处理，
 * 这里不恢复已脱敏的用户目录，也不读取来源文件。
 */
export function reviewArtifactLabel(payload: JsonValue): string | undefined {
  const value = record(payload)
  const action = stringValue(value, 'action', 'event', 'type').toLowerCase()
  if (action === 'image.view') return agentLensI18n.t('review:local.event.imageViewed')
  if (action === 'image.generate' || action === 'image.generation') return agentLensI18n.t('review:local.event.imageGenerated')
  if (action === 'file.patch') return agentLensI18n.t('review:local.event.patchApplied')
  if (action === 'file.attached') return agentLensI18n.t('review:local.event.fileAttached')
  if (action !== 'file.change') return undefined

  const types = new Set(artifactChangeTypes(value.changes))
  if (types.size === 1 && types.has('create')) return agentLensI18n.t('review:local.event.filesAdded')
  if (types.size === 1 && types.has('delete')) return agentLensI18n.t('review:local.event.filesDeleted')
  if (types.size === 1 && types.has('update')) return agentLensI18n.t('review:local.event.filesUpdated')
  return agentLensI18n.t('review:local.event.filesChanged')
}

export function reviewArtifactSummary(payload: JsonValue): string {
  const value = record(payload)
  const action = stringValue(value, 'action', 'event', 'type').toLowerCase()
  const files = artifactFiles(value.changes)
  const nativeFiles = Array.isArray(value.files)
    ? value.files.filter((item): item is string => typeof item === 'string')
    : []
  const visibleFiles = files.length ? files : nativeFiles
  if (visibleFiles.length) {
    const names = visibleFiles.map(path => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path)
    return names.length === 1
      ? names[0]!
      : agentLensI18n.t('review:local.event.filesCount', { count: names.length, first: names[0] })
  }
  if (action === 'image.view' || action === 'image.generate' || action === 'image.generation') {
    return stringValue(value, 'path', 'savedPath', 'saved_path')
  }
  if (action === 'file.attached') return stringValue(value, 'filename', 'mime')
  return action
}

/**
 * Source-specific historical vocabulary is presentation metadata, not React
 * behavior. Keep it isolated here until each Integration can contribute the
 * same mapping declaratively.
 */
/** Only explicit lifecycle failures are highlighted; benign metadata may collapse. */
export function isFailedLifecycleEvent(node: ReviewEventNodeDto): boolean {
  if (node.kind !== 'session.lifecycle') return false
  const payload = record(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type').toLowerCase()
  const status = stringValue(payload, 'status', 'result').toLowerCase()
  return ['turn.error', 'turn.aborted', 'task.failed', 'assistant.error'].includes(action)
    || ['error', 'failed', 'failure', 'rejected'].includes(status)
}

export function isSessionTitleUpdate(node: ReviewEventNodeDto): boolean {
  return node.kind === 'session.lifecycle'
    && ['session.title', 'session.renamed'].includes(stringValue(record(node.payload), 'action', 'event', 'type', 'status').toLowerCase())
}

export function reviewEventLabel(node: ReviewEventNodeDto): string {
  if (isSessionTitleUpdate(node)) return agentLensI18n.t('review:local.rawEvents.titleUpdates')
  if (node.kind === 'runtime.startup') return agentLensI18n.t('review:local.event.runtimeStartupInfo')
  if (node.kind === 'thinking.level.changed') return agentLensI18n.t('review:local.event.thinkingLevelChanged')
  const payload = record(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status').toLowerCase()

  if (node.kind === 'artifact.action') return reviewArtifactLabel(node.payload) ?? node.label

  // Presentation is keyed by canonical kind + verified native action, never Agent identity.
  // Source adapters preserve raw payload and can add future stable semantics without UI forks.
  if (node.kind === 'session.lifecycle') {
    const lifecycleLabels: Record<string, string> = {
      'turn.context': 'codexTurnContext',
      'turn.started': 'codexTurnStarted',
      'turn.completed': 'codexTurnCompleted',
      'turn.aborted': 'codexTurnAborted',
      'turn.error': 'turnFailed',
      'assistant.error': 'piAssistantError',
      'assistant.cancelled': 'piAssistantCancelled',
      'pi.bash': 'piShell',
      'pi.bash_execution': 'piShell',
      'pi.bash_result': 'piShellResult',
    }
    const key = lifecycleLabels[action]
    if (key) return agentLensI18n.t(`review:local.event.${key}`)
    if (action.includes('stop')) return agentLensI18n.t('review:local.event.turnStop')
  }
  if (node.kind === 'model.changed') return agentLensI18n.t('review:local.event.modelChanged')
  if (node.kind === 'context.injected' && action === 'instructions.loaded') return agentLensI18n.t('review:local.event.instructionsLoaded')
  if (node.kind === 'context.injected') return agentLensI18n.t('review:local.event.injectedContext')
  if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
  if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.contextSummary')
  if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
  if (node.kind === 'subagent.end') return agentLensI18n.t('review:local.event.subagentEnd')
  if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')

  // Common source-backed actions use stable vocabulary across Agent adapters.
  const commonLifecycle: Record<string, string> = {
    'context.edited': 'contextEdited',
    'config.changed': 'configChanged',
    'task.created': 'taskCreated',
    'task.completed': 'taskCompleted',
    'notification.received': 'notificationReceived',
    'subtask.requested': 'subtaskRequested',
    'agent.selected': 'agentSelected',
    'model.retry': 'modelRetry',
    'session.finalized': 'sessionFinalized',
    'session.reset': 'sessionReset',
    'human.input.requested': 'humanInputRequested',
    'human.input.resolved': 'humanInputResolved',
    'turn.error': 'turnFailed',
  }
  const commonKey = node.kind === 'session.lifecycle' ? commonLifecycle[action] : undefined
  if (commonKey) return agentLensI18n.t(`review:local.event.${commonKey}`)
  if (node.kind === 'permission.response') return agentLensI18n.t('review:local.event.permissionResponse')
  return node.label
}
