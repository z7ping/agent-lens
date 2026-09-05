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
import { assistantMessageProvenance, contextClassification } from './provenance'

export const CODEX_CURRENT_PARSER_VERSION = '17'

const NON_ACTIVITY_ROLLOUT_TYPES = new Set([
  'world_state',
  'retained_context',
  'security_risk_score',
  'realtime_item',
  'inter_agent_communication_metadata',
])

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

function rolloutEntry(record: SourceRecord): { entry: Record<string, any>; payload: Record<string, any> } {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  return { entry, payload: asRecord(entry.payload) }
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

function isTransportEchoRecord(record: SourceRecord): boolean {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'response_item' || payload.type !== 'message') return false
  const role = stringField(payload, 'role')?.toLowerCase()
  if (role !== 'user') return false
  const text = messageText(payload.content ?? payload.text ?? '')
  return contextClassification(role, text).kind === 'transport-echo'
}

function isNonActivitySnapshotRecord(record: SourceRecord): boolean {
  const { entry } = rolloutEntry(record)
  return typeof entry.type === 'string' && NON_ACTIVITY_ROLLOUT_TYPES.has(entry.type)
}

function isEmptyLegacyAssistantOrReasoning(record: SourceRecord): boolean {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'event_msg') return false
  if (payload.type === 'agent_message') {
    const text = stringField(payload, 'message', 'text') ?? messageText(payload.content)
    return !text.trim()
  }
  if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content') {
    const text = stringField(payload, 'text') ?? messageText(payload.content)
    return !text.trim()
  }
  return false
}

type AssistantEvent = {
  source: 'event_msg.agent_message'
  text: string
  phase?: string
  raw: Record<string, unknown>
}

function directAssistantEvent(record: SourceRecord): AssistantEvent | null {
  const { entry, payload } = rolloutEntry(record)
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
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'event_msg' || payload.type !== 'agent_reasoning_raw_content') return null
  return stringField(payload, 'text') ? payload : null
}

type PersistedThreadMetadataEvent = {
  event: 'thread.goal.updated' | 'thread.rolled-back' | 'thread.settings.applied'
  payload: Record<string, unknown>
  modelName?: string
  workspacePath?: string
}

function persistedThreadMetadataEvent(record: SourceRecord): PersistedThreadMetadataEvent | null {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'event_msg') return null

  if (payload.type === 'thread_goal_updated') {
    return { event: 'thread.goal.updated', payload }
  }
  if (payload.type === 'thread_rolled_back') {
    return { event: 'thread.rolled-back', payload }
  }
  if (payload.type === 'thread_settings_applied') {
    const settings = asRecord(payload.thread_settings ?? payload.threadSettings)
    const modelName = stringField(settings, 'model')
    const workspacePath = stringField(settings, 'cwd')
    return {
      event: 'thread.settings.applied',
      payload,
      ...(modelName ? { modelName } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    }
  }
  return null
}

function interAgentCommunication(record: SourceRecord): Record<string, unknown> | null {
  const { entry, payload } = rolloutEntry(record)
  return entry.type === 'inter_agent_communication' ? payload : null
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

async function normalizePersistedThreadMetadata(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  metadata: PersistedThreadMetadataEvent,
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(record, ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'unknown'
      ? {
          ...observation,
          kind: 'session.lifecycle',
          payload: {
            ...metadata.payload,
            event: metadata.event,
          },
          identityHints: {
            ...observation.identityHints,
            ...(metadata.modelName ? { modelName: metadata.modelName } : {}),
            ...(metadata.workspacePath ? { workspacePath: metadata.workspacePath } : {}),
          },
        }
      : observation),
  }
}

async function normalizeInterAgentCommunication(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, unknown>,
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(record, ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'unknown'
      ? {
          ...observation,
          kind: 'session.lifecycle',
          payload: {
            ...payload,
            event: 'subagent.communication',
          },
        }
      : observation),
  }
}

async function normalizeWithoutActivity(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const normalized = await normalizeCodexRecord(record, ctx)
  return {
    ...normalized,
    observations: [],
  }
}

/**
 * Current Codex has two persisted history modes:
 * - Legacy: user_message / agent_message / reasoning events.
 * - Paginated: event_msg.item_completed with a structured TurnItem.
 *
 * State snapshots and model-invisible presentation facts remain available as
 * SourceRecord/Evidence but do not manufacture Review activities. Persistent
 * thread metadata and inter-agent communication are mapped explicitly.
 * Authorship and activity ownership are never inferred from message text.
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  if (isTransportEchoRecord(record) || isNonActivitySnapshotRecord(record) || isEmptyLegacyAssistantOrReasoning(record)) {
    return normalizeWithoutActivity(record, ctx)
  }

  const functionOutput = await normalizePaginatedFunctionOutput(record, ctx)
  if (functionOutput) return functionOutput

  const paginated = await normalizePaginatedCodexRecord(record, ctx)
  if (paginated) return paginated

  const threadMetadata = persistedThreadMetadataEvent(record)
  if (threadMetadata) return normalizePersistedThreadMetadata(record, ctx, threadMetadata)

  const communication = interAgentCommunication(record)
  if (communication) return normalizeInterAgentCommunication(record, ctx, communication)

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
  isTransportEchoRecord,
  isNonActivitySnapshotRecord,
  isEmptyLegacyAssistantOrReasoning,
  persistedThreadMetadataEvent,
  interAgentCommunication,
}
