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

function sourceVisibleReasoning(record: SourceRecord): { text: string; raw: JsonValue } | null {
  if (record.locator.kind === 'runtime-hook') return null

  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  if (entry.type !== 'event_msg') return null

  const payload = asRecord(entry.payload)
  const type = typeof payload.type === 'string' ? payload.type : ''
  if (type !== 'agent_reasoning' && type !== 'reasoning') return null

  const text = messageText(
    payload.text
      ?? payload.message
      ?? payload.reasoning
      ?? payload.summary
      ?? payload.content
      ?? '',
  ).trim()
  if (!text) return null

  return { text, raw: payload as JsonValue }
}

/**
 * Codex rollout 在不同版本里有两条 source-visible Thinking 记录路径：
 * - response_item / reasoning（原 normalizer 已支持）
 * - event_msg / agent_reasoning（近期 Codex CLI 常见）
 *
 * 后者此前会落成 unknown，导致 Review 投影虽然支持 message.reasoning，UI 仍看不到 Thinking。
 * 这里在保持原 evidence / identity / dedup 的前提下，把该 unknown 提升为 message.reasoning。
 */
export async function normalizeCodexRecordWithVisibleReasoning(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const normalized = await normalizeCodexRecord(record, ctx)
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
