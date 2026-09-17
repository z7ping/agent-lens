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

/**
 * Source-specific historical vocabulary is presentation metadata, not React
 * behavior. Keep it isolated here until each Integration can contribute the
 * same mapping declaratively.
 */
export function reviewEventLabel(node: ReviewEventNodeDto): string {
  if (node.kind === 'runtime.startup') return agentLensI18n.t('review:local.event.runtimeStartupInfo')
  const payload = record(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status').toLowerCase()

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
