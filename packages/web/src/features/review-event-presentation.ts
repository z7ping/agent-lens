import type { JsonValue, ReviewEventNodeDto } from '@agent-lens/protocol'
import { agentLensI18n } from '../i18n/runtime'

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
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
export function reviewEventLabel(node: ReviewEventNodeDto): string {
  if (node.kind === 'runtime.startup') return agentLensI18n.t('review:local.event.runtimeStartupInfo')
  if (node.kind === 'thinking.level.changed') return agentLensI18n.t('review:local.event.thinkingLevelChanged')
  const payload = record(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status').toLowerCase()

  if (node.kind === 'artifact.action') return reviewArtifactLabel(node.payload) ?? node.label

  if (node.sourceId === 'codex') {
    if (node.kind === 'session.lifecycle' && action === 'turn.context') return agentLensI18n.t('review:local.event.codexTurnContext')
    if (node.kind === 'session.lifecycle' && action === 'turn.started') return agentLensI18n.t('review:local.event.codexTurnStarted')
    if (node.kind === 'session.lifecycle' && action === 'turn.completed') return agentLensI18n.t('review:local.event.codexTurnCompleted')
    if (node.kind === 'session.lifecycle' && action === 'turn.aborted') return agentLensI18n.t('review:local.event.codexTurnAborted')
    if (node.kind === 'session.lifecycle' && action === 'turn.error') return agentLensI18n.t('review:local.event.codexTurnError')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
    if (node.kind === 'context.injected') return agentLensI18n.t('review:local.event.injectedContext')
    if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
    if (node.kind === 'subagent.end') return agentLensI18n.t('review:local.event.subagentEnd')
    if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')
    if (node.kind === 'session.lifecycle' && action.includes('stop')) return agentLensI18n.t('review:local.event.turnStop')
  }

  if (node.sourceId === 'claude-code') {
    if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')
    if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
    if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.contextSummary')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
  }

  if (node.sourceId === 'pi') {
    // Canonical lifecycle 原样保留；展示层按已经确认的原生 action 给出易读标签。
    if (node.kind === 'session.lifecycle') {
      if (action === 'assistant.error') return agentLensI18n.t('review:local.event.piAssistantError')
      if (action === 'assistant.cancelled') return agentLensI18n.t('review:local.event.piAssistantCancelled')
      if (action === 'pi.bash' || action === 'pi.bash_execution') return agentLensI18n.t('review:local.event.piShell')
      if (action === 'pi.bash_result') return agentLensI18n.t('review:local.event.piShellResult')
    }
    if (node.kind === 'model.changed') return agentLensI18n.t('review:local.event.modelChanged')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
    if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.branchSummary')
  }

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
  if (node.kind === 'context.injected' && action === 'instructions.loaded') {
    return agentLensI18n.t('review:local.event.instructionsLoaded')
  }
  if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
  if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.contextSummary')
  if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')
  if (node.kind === 'permission.response') return agentLensI18n.t('review:local.event.permissionResponse')
  if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
  if (node.kind === 'subagent.end') return agentLensI18n.t('review:local.event.subagentEnd')
  return node.label
}
