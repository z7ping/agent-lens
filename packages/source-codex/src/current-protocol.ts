import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import { assistantMessageProvenance } from './provenance'

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

type AssistantEvent = {
  source: 'event_msg.agent_message' | 'response_item.message.role=assistant'
  text: string
  phase?: string
}

function assistantEvent(record: SourceRecord): AssistantEvent | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  const phase = typeof payload.phase === 'string' && payload.phase ? payload.phase : undefined

  if (entry.type === 'event_msg' && payload.type === 'agent_message') {
    const text = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.text === 'string'
        ? payload.text
        : messageText(payload.content)
    return text
      ? { source: 'event_msg.agent_message', text, ...(phase ? { phase } : {}) }
      : null
  }

  if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const text = messageText(payload.content ?? payload.text ?? '')
    return text
      ? { source: 'response_item.message.role=assistant', text, ...(phase ? { phase } : {}) }
      : null
  }

  return null
}

function sharedAssistantEventKey(record: SourceRecord, event: AssistantEvent): string | undefined {
  if (!record.occurredAt) return undefined
  return `codex-assistant:${record.occurredAt}:${event.phase ?? ''}:${event.text}`
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
  record: SourceRecord,
  event: AssistantEvent,
): ObservationCandidate {
  if (observation.kind !== 'message.assistant' && observation.kind !== 'message.commentary') return observation

  const sharedEventKey = sharedAssistantEventKey(record, event)
  const originalPayload = asRecord(observation.payload)
  const { content: _syntheticContent, provenance: _provenance, ...visiblePayload } = originalPayload
  const payload = event.source === 'event_msg.agent_message'
    ? {
        ...visiblePayload,
        provenance: assistantMessageProvenance('assistant', 'event_msg.agent_message'),
      }
    : originalPayload

  return {
    ...observation,
    payload,
    dedupHints: {
      ...observation.dedupHints,
      ...(sharedEventKey ? { sharedEventKey } : {}),
    },
  }
}

/**
 * 兼容当前 Codex rollout 协议：正常 Assistant 输出同时可能以
 * event_msg.agent_message 与 response_item/message 两种原生记录出现。
 * 两者都保留 SourceRecord/Evidence，但 Canonical 层使用结构化共享键合并为一次回复。
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const event = assistantEvent(record)
  if (!event) return normalizeCodexRecord(record, ctx)

  const normalized = await normalizeCodexRecord(
    event.source === 'event_msg.agent_message' ? asResponseItem(record, event) : record,
    ctx,
  )

  return {
    ...normalized,
    observations: normalized.observations.map(observation => alignAssistantCandidate(observation, record, event)),
  }
}

export const currentCodexProtocolInternals = {
  assistantEvent,
  sharedAssistantEventKey,
}
