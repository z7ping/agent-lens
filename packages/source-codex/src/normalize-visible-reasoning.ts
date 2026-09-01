import type {
  JsonValue,
  NormalizedSourceOutput,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText } from './format'
import { normalizeCodexRecord } from './normalize'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const visibleReasoningTypes = new Set([
  'agent_reasoning',
  'reasoning',
  'reasoning_summary',
])

function firstVisibleText(payload: Record<string, unknown>): string {
  for (const value of [
    payload.text,
    payload.message,
    payload.reasoning,
    payload.summary,
    payload.content,
  ]) {
    const text = messageText(value).trim()
    if (text) return text
  }
  return ''
}

function sourceVisibleReasoning(record: SourceRecord): { text: string; raw: JsonValue } | null {
  if (record.locator.kind === 'runtime-hook') return null

  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  if (entry.type !== 'event_msg') return null

  const payload = asRecord(entry.payload)
  const type = typeof payload.type === 'string' ? payload.type : ''
  if (!visibleReasoningTypes.has(type)) return null

  const text = firstVisibleText(payload)
  if (!text) return null
  return { text, raw: payload as JsonValue }
}

/**
 * Codex rollout 的 source-visible Thinking 目前至少有两条历史路径：
 * - response_item / reasoning：基础 normalizer 直接处理；
 * - event_msg / agent_reasoning|reasoning|reasoning_summary：这里兼容不同 CLI 版本。
 *
 * 只提升来源明确暴露的 reasoning，不猜测隐藏 CoT，也不把 reasoning token 统计误当正文。
 */
export async function normalizeCodexRecordWithVisibleReasoning(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const normalized = await normalizeCodexRecord(record, ctx)
  if (normalized.observations.some(observation => observation.kind === 'message.reasoning')) return normalized

  const reasoning = sourceVisibleReasoning(record)
  if (!reasoning) return normalized

  let promoted = false
  const observations = normalized.observations.map(observation => {
    if (promoted || observation.kind !== 'unknown') return observation
    promoted = true
    return {
      ...observation,
      kind: 'message.reasoning' as const,
      payload: {
        text: reasoning.text,
        raw: reasoning.raw,
      },
    }
  })

  return promoted ? { ...normalized, observations } : normalized
}
