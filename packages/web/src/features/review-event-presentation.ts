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
  if (action === 'image.generate') return agentLensI18n.t('review:local.event.imageGenerated')
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
  if (files.length) {
    const names = files.map(path => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path)
    return names.length === 1
      ? names[0]!
      : agentLensI18n.t('review:local.event.filesCount', { count: names.length, first: names[0] })
  }
  if (action === 'image.view' || action === 'image.generate') {
    return stringValue(value, 'path', 'savedPath', 'saved_path')
  }
  return action
}

/**
 * Source-specific historical vocabulary is presentation metadata, not React
 * behavior. Keep it isolated here until each Integration can contribute the
 * same mapping declaratively.
 */
export function reviewEventLabel(node: ReviewEventNodeDto): string {
  if (node.kind === 'runtime.startup') return agentLensI18n.t('review:local.event.runtimeStartupInfo')
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
    if (node.kind === 'model.changed') return agentLensI18n.t('review:local.event.modelChanged')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
    if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.branchSummary')
  }

  return node.label
}
