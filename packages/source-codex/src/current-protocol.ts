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

export const CODEX_CURRENT_PARSER_VERSION = '19'

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

function mergeOutputs(outputs: NormalizedSourceOutput[]): NormalizedSourceOutput {
  const relationships = outputs.flatMap(output => output.sessionRelationshipHints ?? [])
  const coverage = outputs.flatMap(output => output.coverage ?? [])
  return {
    observations: outputs.flatMap(output => output.observations),
    evidenceCandidates: outputs[0]?.evidenceCandidates ?? [],
    ...(relationships.length ? { sessionRelationshipHints: relationships } : {}),
    ...(coverage.length ? { coverage } : {}),
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

function isOpaqueResponseReasoningRecord(record: SourceRecord): boolean {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'response_item' || payload.type !== 'reasoning') return false
  const visible = messageText(payload.summary ?? payload.content ?? payload.text ?? '').trim()
  return !visible
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

async function remapUnknown(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  kind: ObservationCandidate['kind'],
  payload: Record<string, unknown>,
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(record, ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'unknown'
      ? { ...observation, kind, payload }
      : observation),
  }
}

function plaintextAgentMessageContent(content: unknown): { text?: string; encrypted: boolean } {
  if (!Array.isArray(content)) return { encrypted: false }
  const parts: string[] = []
  let encrypted = false
  for (const value of content) {
    const item = asRecord(value)
    if (item.type === 'input_text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text)
    } else if (item.type === 'encrypted_content') {
      encrypted = true
    }
  }
  const text = parts.join('\n').trim()
  return { ...(text ? { text } : {}), encrypted }
}

async function normalizeResponseAgentMessage(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  const content = plaintextAgentMessageContent(payload.content)
  return remapUnknown(record, ctx, 'session.lifecycle', {
    event: 'subagent.communication',
    communicationType: 'response.agent_message',
    author: stringField(payload, 'author') ?? 'unknown',
    recipient: stringField(payload, 'recipient') ?? 'unknown',
    ...(content.text ? { text: content.text } : {}),
    ...(content.encrypted ? { encryptedContent: true } : {}),
  })
}

async function normalizeResponseLocalShellCall(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  const callId = stringField(payload, 'call_id', 'id') ?? `local-shell-${record.sourceSequence ?? record.id}`
  const status = stringField(payload, 'status')?.toLowerCase() ?? 'unknown'
  const call = await normalizeCodexRecord(syntheticEntryRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'local_shell',
      call_id: callId,
      arguments: JSON.stringify({ action: payload.action ?? null }),
    },
  }), ctx)
  call.observations = call.observations.map(observation => observation.kind === 'tool.call'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          status,
          rawAction: payload.action ?? null,
        },
      }
    : observation)
  if (status === 'in_progress') return call

  const result = await normalizeCodexRecord(syntheticEntryRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ status }),
    },
  }), ctx)
  result.observations = result.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: 'local_shell',
          success: status === 'completed',
          status,
        },
      }
    : observation)
  return mergeOutputs([call, result])
}

async function normalizeResponseToolSearchCall(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  const callId = stringField(payload, 'call_id', 'id') ?? `tool-search-${record.sourceSequence ?? record.id}`
  const output = await normalizeCodexRecord(syntheticEntryRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'tool_search',
      call_id: callId,
      arguments: JSON.stringify({
        execution: payload.execution ?? null,
        arguments: payload.arguments ?? null,
        status: payload.status ?? null,
      }),
    },
  }), ctx)
  output.observations = output.observations.map(observation => observation.kind === 'tool.call'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          status: payload.status ?? null,
        },
      }
    : observation)
  return output
}

async function normalizeResponseImageGeneration(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  return remapUnknown(record, ctx, 'artifact.action', {
    action: 'image.generate',
    status: payload.status ?? null,
    ...(stringField(payload, 'revised_prompt', 'revisedPrompt') ? {
      revisedPrompt: stringField(payload, 'revised_prompt', 'revisedPrompt'),
    } : {}),
    resultAvailable: typeof payload.result === 'string' && payload.result.length > 0,
  })
}

async function normalizeResponseConfigurationUpdate(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  const reasoning = asRecord(payload.reasoning)
  return remapUnknown(record, ctx, 'session.lifecycle', {
    event: 'reasoning.configuration.updated',
    reasoning: {
      ...(stringField(reasoning, 'effort') ? { effort: stringField(reasoning, 'effort') } : {}),
    },
  })
}

async function normalizeResponseCompaction(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  payload: Record<string, any>,
): Promise<NormalizedSourceOutput> {
  return remapUnknown(record, ctx, 'context.compaction', {
    phase: 'snapshot',
    sourceType: `response_item.${payload.type ?? 'compaction'}`,
    opaque: true,
  })
}

async function normalizePersistedResponseItem(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'response_item') return null
  switch (payload.type) {
    case 'agent_message': return normalizeResponseAgentMessage(record, ctx, payload)
    case 'local_shell_call': return normalizeResponseLocalShellCall(record, ctx, payload)
    case 'tool_search_call': return normalizeResponseToolSearchCall(record, ctx, payload)
    case 'image_generation_call': return normalizeResponseImageGeneration(record, ctx, payload)
    case 'configuration_update': return normalizeResponseConfigurationUpdate(record, ctx, payload)
    case 'compaction':
    case 'compaction_summary':
    case 'context_compaction':
      return normalizeResponseCompaction(record, ctx, payload)
    default: return null
  }
}

function normalizedEventValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[\s-]+/g, '_').toLowerCase() : ''
}

function withNativeCallId(output: NormalizedSourceOutput, callId: string): NormalizedSourceOutput {
  return {
    ...output,
    observations: output.observations.map(observation => ({
      ...observation,
      nativeCallId: callId,
      dedupHints: {
        ...observation.dedupHints,
        nativeCallId: callId,
      },
    })),
  }
}

function mcpResultSuccess(value: unknown): boolean | undefined {
  const result = asRecord(value)
  if ('Err' in result || 'err' in result) return false
  const ok = asRecord(result.Ok ?? result.ok ?? value)
  if (typeof ok.is_error === 'boolean') return !ok.is_error
  if (typeof ok.isError === 'boolean') return !ok.isError
  if ('Ok' in result || 'ok' in result) return true
  return undefined
}

async function normalizePersistedLegacyEvent(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const { entry, payload } = rolloutEntry(record)
  if (entry.type !== 'event_msg') return null

  if (payload.type === 'entered_review_mode') {
    return remapUnknown(record, ctx, 'session.lifecycle', {
      ...payload,
      event: 'review.entered',
      reviewMode: true,
    })
  }
  if (payload.type === 'exited_review_mode') {
    return remapUnknown(record, ctx, 'session.lifecycle', {
      ...payload,
      event: 'review.exited',
      reviewMode: false,
    })
  }
  if (payload.type === 'patch_apply_end') {
    return remapUnknown(record, ctx, 'artifact.action', {
      ...payload,
      action: 'file.change',
      sourceType: 'event_msg.patch_apply_end',
    })
  }
  if (payload.type === 'mcp_tool_call_end') {
    const callId = stringField(payload, 'call_id') ?? `mcp-${record.sourceSequence ?? record.id}`
    const invocation = asRecord(payload.invocation)
    const tool = stringField(invocation, 'tool', 'tool_name', 'name') ?? 'mcp_tool'
    const server = stringField(invocation, 'server')
    const success = mcpResultSuccess(payload.result)
    const output = await remapUnknown(record, ctx, 'tool.result', {
      callId,
      nativeToolName: server ? `${server}.${tool}` : tool,
      ...(success === undefined ? {} : { success }),
      output: payload.result ?? null,
      raw: payload,
    })
    return withNativeCallId(output, callId)
  }
  if (payload.type === 'web_search_end') {
    const callId = stringField(payload, 'call_id') ?? `web-search-${record.sourceSequence ?? record.id}`
    const output = await remapUnknown(record, ctx, 'tool.result', {
      callId,
      nativeToolName: 'web_search',
      success: true,
      output: payload.results ?? {
        query: payload.query ?? null,
        action: payload.action ?? null,
      },
      raw: payload,
    })
    return withNativeCallId(output, callId)
  }
  if (payload.type === 'image_generation_end') {
    const callId = stringField(payload, 'call_id')
    return remapUnknown(record, ctx, 'artifact.action', {
      action: 'image.generate',
      sourceType: 'event_msg.image_generation_end',
      ...(callId ? { callId } : {}),
      status: payload.status ?? null,
      ...(stringField(payload, 'revised_prompt', 'revisedPrompt') ? {
        revisedPrompt: stringField(payload, 'revised_prompt', 'revisedPrompt'),
      } : {}),
      ...(payload.saved_path === undefined && payload.savedPath === undefined ? {} : {
        savedPath: payload.saved_path ?? payload.savedPath,
      }),
      resultAvailable: typeof payload.result === 'string' && payload.result.length > 0,
      raw: payload,
    })
  }
  if (payload.type === 'subagent_activity') {
    const activity = normalizedEventValue(payload.kind)
    const actorId = stringField(payload, 'agent_thread_id', 'agentThreadId')
    const kind: ObservationCandidate['kind'] = activity === 'started'
      ? 'subagent.spawn'
      : activity === 'completed' || activity === 'interrupted'
        ? 'subagent.end'
        : 'session.lifecycle'
    const output = await remapUnknown(record, ctx, kind, {
      ...(kind === 'session.lifecycle' ? { event: 'subagent.interacted' } : {}),
      activityKind: payload.kind ?? null,
      agentThreadId: actorId ?? null,
      agentPath: payload.agent_path ?? payload.agentPath ?? null,
      raw: payload,
    })
    return {
      ...output,
      observations: output.observations.map(observation => ({
        ...observation,
        identityHints: {
          ...observation.identityHints,
          ...(actorId ? { nativeActorId: actorId } : {}),
          actorRole: 'subagent',
        },
      })),
    }
  }

  return null
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
 * thread metadata, agent communication, durable ResponseItems, and official
 * persisted legacy EventMsg variants are mapped from their native structure.
 * Authorship is never inferred from message text.
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  if (isTransportEchoRecord(record) || isNonActivitySnapshotRecord(record) || isOpaqueResponseReasoningRecord(record) || isEmptyLegacyAssistantOrReasoning(record)) {
    return normalizeWithoutActivity(record, ctx)
  }

  const functionOutput = await normalizePaginatedFunctionOutput(record, ctx)
  if (functionOutput) return functionOutput

  const paginated = await normalizePaginatedCodexRecord(record, ctx)
  if (paginated) return paginated

  const responseItem = await normalizePersistedResponseItem(record, ctx)
  if (responseItem) return responseItem

  const legacyEvent = await normalizePersistedLegacyEvent(record, ctx)
  if (legacyEvent) return legacyEvent

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
  isOpaqueResponseReasoningRecord,
  isEmptyLegacyAssistantOrReasoning,
  persistedThreadMetadataEvent,
  interAgentCommunication,
  plaintextAgentMessageContent,
  normalizePersistedResponseItem,
  normalizePersistedLegacyEvent,
}
