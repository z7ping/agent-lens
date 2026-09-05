import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import { normalizePaginatedFunctionOutput } from './paginated-function-output'
import { normalizePaginatedCodexRecord } from './paginated-protocol'
import { assistantMessageProvenance } from './provenance'

export const CODEX_CURRENT_PARSER_VERSION = '14'

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

function stringField(record: Record<string, any>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function syntheticEntryRecord(record: SourceRecord, entry: Record<string, unknown>): SourceRecord {
  const envelope = asRecord(record.payload) as CodexStoredEnvelope
  return {
    ...record,
    payload: {
      ...envelope,
      entry,
    } as SourceRecord['payload'],
  }
}

type AssistantEvent = {
  source: 'event_msg.agent_message'
  text: string
  phase?: string
  raw: Record<string, unknown>
}

function directAssistantEvent(record: SourceRecord): AssistantEvent | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  if (entry.type !== 'event_msg' || payload.type !== 'agent_message') return null

  const text = stringField(payload, 'message', 'text') ?? messageText(payload.content)
  if (!text) return null
  const phase = stringField(payload, 'phase')
  return {
    source: 'event_msg.agent_message',
    text,
    ...(phase ? { phase } : {}),
    raw: payload,
  }
}

function directRawReasoning(record: SourceRecord): Record<string, unknown> | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  if (entry.type !== 'event_msg' || payload.type !== 'agent_reasoning_raw_content') return null
  return stringField(payload, 'text') ? payload : null
}

function asAssistantResponseItem(record: SourceRecord, event: AssistantEvent): SourceRecord {
  return syntheticEntryRecord(record, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: event.text }],
      ...(event.phase ? { phase: event.phase } : {}),
    },
  })
}

function alignAssistantCandidate(
  observation: ObservationCandidate,
  event: AssistantEvent,
): ObservationCandidate {
  if (observation.kind !== 'message.assistant' && observation.kind !== 'message.commentary') return observation

  const original = asRecord(observation.payload)
  const { content: _syntheticContent, provenance: _legacyProvenance, ...visible } = original
  return {
    ...observation,
    payload: {
      ...visible,
      provenance: assistantMessageProvenance('assistant', event.source),
      raw: event.raw,
    },
  }
}

async function normalizeDirectRawReasoning(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, unknown>,
): Promise<NormalizedSourceOutput> {
  const text = stringField(payload, 'text') ?? ''
  const output = await normalizeCodexRecord(syntheticEntryRecord(record, {
    type: 'event_msg',
    payload: { type: 'agent_reasoning', text },
  }), ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'message.reasoning'
      ? {
          ...observation,
          payload: {
            ...asRecord(observation.payload),
            rawReasoning: true,
            sourceSignal: 'event_msg.agent_reasoning_raw_content',
            raw: payload,
          },
        }
      : observation),
  }
}

/**
 * Current Codex has two persisted history modes:
 * - Legacy: user_message / agent_message / reasoning events.
 * - Paginated: event_msg.item_completed with a structured TurnItem.
 *
 * We only dispatch on native structure here. Authorship and activity ownership
 * are never inferred from message text.
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const functionOutput = await normalizePaginatedFunctionOutput(record, ctx)
  if (functionOutput) return functionOutput

  const paginated = await normalizePaginatedCodexRecord(record, ctx)
  if (paginated) return paginated

  const rawReasoning = directRawReasoning(record)
  if (rawReasoning) return normalizeDirectRawReasoning(record, ctx, rawReasoning)

  const event = directAssistantEvent(record)
  if (!event) return normalizeCodexRecord(record, ctx)

  const normalized = await normalizeCodexRecord(asAssistantResponseItem(record, event), ctx)
  return {
    ...normalized,
    observations: normalized.observations.map(observation => alignAssistantCandidate(observation, event)),
  }
}

export const currentCodexProtocolInternals = {
  directAssistantEvent,
  directRawReasoning,
}
