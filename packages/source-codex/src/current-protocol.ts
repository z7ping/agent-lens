import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import { assistantMessageProvenance } from './provenance'

export const CODEX_CURRENT_PARSER_VERSION = '13'

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

type AssistantEvent = {
  source: 'event_msg.agent_message'
  text: string
  phase?: string
}

function assistantEvent(record: SourceRecord): AssistantEvent | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  if (entry.type !== 'event_msg' || payload.type !== 'agent_message') return null

  const text = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.text === 'string'
      ? payload.text
      : messageText(payload.content)
  if (!text) return null

  const phase = typeof payload.phase === 'string' && payload.phase ? payload.phase : undefined
  return { source: 'event_msg.agent_message', text, ...(phase ? { phase } : {}) }
}

function asResponseItem(record: SourceRecord, event: AssistantEvent): SourceRecord {
  const envelope = asRecord(record.payload) as CodexStoredEnvelope
  const entry = asRecord(envelope.entry)
  return {
    ...record,
    payload: {
      ...envelope,
      entry: {
        ...entry,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: event.text }],
          ...(event.phase ? { phase: event.phase } : {}),
        },
      },
    } as SourceRecord['payload'],
  }
}

function alignAssistantCandidate(
  observation: ObservationCandidate,
  event: AssistantEvent,
): ObservationCandidate {
  if (observation.kind !== 'message.assistant' && observation.kind !== 'message.commentary') return observation

  const originalPayload = asRecord(observation.payload)
  const { content: _syntheticContent, provenance: _legacyProvenance, ...visiblePayload } = originalPayload
  return {
    ...observation,
    payload: {
      ...visiblePayload,
      provenance: assistantMessageProvenance('assistant', event.source),
    },
  }
}

/**
 * 当前 Codex 的可见 Assistant 历史以 event_msg.agent_message 为权威信号。
 * 官方 ThreadHistoryBuilder 会消费 AgentMessage，并忽略 response_item 中的 assistant message；
 * 这里复用旧 message 解析逻辑，但保留原生 event_msg provenance。
 *
 * 旧 rollout 仍可能只有 response_item/message role=assistant，因此非 agent_message
 * 继续交给旧 normalizer 兼容，不在这里用正文/时间戳做跨记录猜测去重。
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const event = assistantEvent(record)
  if (!event) return normalizeCodexRecord(record, ctx)

  const normalized = await normalizeCodexRecord(asResponseItem(record, event), ctx)
  return {
    ...normalized,
    observations: normalized.observations.map(observation => alignAssistantCandidate(observation, event)),
  }
}

export const currentCodexProtocolInternals = {
  assistantEvent,
}
