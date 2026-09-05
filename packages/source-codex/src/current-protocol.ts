import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import { assistantMessageProvenance, userMessageProvenance } from './provenance'

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

function normalizedItemType(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[_-]/g, '').toLowerCase() : ''
}

function syntheticRecord(
  record: SourceRecord,
  entry: Record<string, unknown>,
  nativeId?: string,
): SourceRecord {
  const envelope = asRecord(record.payload) as CodexStoredEnvelope
  return {
    ...record,
    ...(nativeId ? { nativeId } : { nativeId: undefined }),
    payload: {
      ...envelope,
      entry,
    } as SourceRecord['payload'],
  }
}

function mergeOutputs(outputs: NormalizedSourceOutput[]): NormalizedSourceOutput {
  return {
    observations: outputs.flatMap(output => output.observations),
    evidenceCandidates: outputs[0]?.evidenceCandidates ?? [],
    sessionRelationshipHints: outputs.flatMap(output => output.sessionRelationshipHints ?? []),
    coverage: outputs.flatMap(output => output.coverage ?? []),
  }
}

type AssistantEvent = {
  source: 'event_msg.agent_message' | 'event_msg.item_completed.AgentMessage'
  text: string
  phase?: string
  turnId?: string
  raw?: Record<string, unknown>
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

function asAssistantResponseItem(
  record: SourceRecord,
  event: AssistantEvent,
  nativeId?: string,
): SourceRecord {
  return syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: event.text }],
      ...(event.phase ? { phase: event.phase } : {}),
    },
  }, nativeId)
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
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.raw ? { raw: event.raw } : {}),
    },
  }
}

function completedTurnItem(record: SourceRecord): {
  turnId: string
  item: Record<string, any>
  itemId?: string
  type: string
} | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  if (entry.type !== 'event_msg' || payload.type !== 'item_completed') return null
  const item = asRecord(payload.item)
  if (!Object.keys(item).length) return null
  return {
    turnId: stringField(payload, 'turn_id', 'turnId') ?? '',
    item,
    itemId: stringField(item, 'id'),
    type: normalizedItemType(item.type),
  }
}

function userItemAttachments(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  return content.filter(value => normalizedItemType(asRecord(value).type) !== 'text')
}

async function normalizeCompletedUserMessage(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const text = messageText(completed.item.content)
  const attachments = userItemAttachments(completed.item.content)
  const synthetic = syntheticRecord(record, {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      ...(attachments.length ? { attachments } : {}),
      turn_id: completed.turnId,
    },
  }, completed.itemId)
  const output = await normalizeCodexRecord(synthetic, ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'message.user'
      ? {
          ...observation,
          payload: {
            ...asRecord(observation.payload),
            provenance: {
              ...userMessageProvenance(),
              sourceSignal: 'event_msg.item_completed.UserMessage',
            },
            turnId: completed.turnId,
            raw: completed.item,
          },
        }
      : observation),
  }
}

async function normalizeCompletedAssistantMessage(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const text = messageText(completed.item.content)
  if (!text) return normalizeCodexRecord(record, ctx)
  const event: AssistantEvent = {
    source: 'event_msg.item_completed.AgentMessage',
    text,
    ...(stringField(completed.item, 'phase') ? { phase: stringField(completed.item, 'phase') } : {}),
    turnId: completed.turnId,
    raw: completed.item,
  }
  const normalized = await normalizeCodexRecord(
    asAssistantResponseItem(record, event, completed.itemId),
    ctx,
  )
  return {
    ...normalized,
    observations: normalized.observations.map(observation => alignAssistantCandidate(observation, event)),
  }
}

async function normalizeCompletedReasoning(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const summary = Array.isArray(completed.item.summary_text)
    ? completed.item.summary_text.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const raw = Array.isArray(completed.item.raw_content)
    ? completed.item.raw_content.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const text = [...summary, ...(summary.length ? [] : raw)].join('\n\n')
  if (!text) return normalizeCodexRecord(record, ctx)

  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: {
      type: 'agent_reasoning',
      text,
      turn_id: completed.turnId,
    },
  }, completed.itemId), ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'message.reasoning'
      ? {
          ...observation,
          payload: {
            ...asRecord(observation.payload),
            turnId: completed.turnId,
            sourceSignal: 'event_msg.item_completed.Reasoning',
            raw: completed.item,
          },
        }
      : observation),
  }
}

function commandOutput(item: Record<string, any>): string {
  for (const key of ['formatted_output', 'aggregated_output']) {
    if (typeof item[key] === 'string' && item[key]) return item[key]
  }
  return [item.stdout, item.stderr]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .join('\n')
}

async function normalizeCompletedCommand(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `command-${record.sourceSequence ?? record.id}`
  const call = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'command_execution',
      call_id: callId,
      arguments: JSON.stringify({
        command: completed.item.command ?? [],
        cwd: completed.item.cwd ?? null,
        parsedCommand: completed.item.parsed_cmd ?? [],
        source: completed.item.source ?? null,
        interactionInput: completed.item.interaction_input ?? null,
      }),
    },
  }, completed.itemId), ctx)

  const status = String(completed.item.status ?? '').toLowerCase()
  if (status === 'in_progress' || status === 'inprogress') return call
  const exitCode = typeof completed.item.exit_code === 'number' ? completed.item.exit_code : undefined
  const body = commandOutput(completed.item)
  const outputText = `${exitCode === undefined ? '' : `Exit code: ${exitCode}\n`}Output:\n${body}`
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: outputText },
  }, completed.itemId), ctx)
  const failed = status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0)
  result.observations = result.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: 'command_execution',
          success: !failed,
          status: completed.item.status ?? null,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation)
  call.observations = call.observations.map(observation => observation.kind === 'tool.call'
    ? { ...observation, payload: { ...asRecord(observation.payload), turnId: completed.turnId, raw: completed.item } }
    : observation)
  return mergeOutputs([call, result])
}

async function normalizeCompletedDynamicTool(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `dynamic-${record.sourceSequence ?? record.id}`
  const name = stringField(completed.item, 'tool') ?? 'dynamic_tool'
  const call = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name,
      call_id: callId,
      input: completed.item.arguments ?? {},
    },
  }, completed.itemId), ctx)
  call.observations = call.observations.map(observation => observation.kind === 'tool.call'
    ? { ...observation, payload: { ...asRecord(observation.payload), turnId: completed.turnId, raw: completed.item } }
    : observation)

  const status = String(completed.item.status ?? '').toLowerCase()
  if (status === 'in_progress' || status === 'inprogress') return call
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: completed.item.content_items ?? completed.item.error ?? null,
    },
  }, completed.itemId), ctx)
  result.observations = result.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: name,
          success: typeof completed.item.success === 'boolean'
            ? completed.item.success
            : status === 'completed',
          status: completed.item.status ?? null,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation)
  return mergeOutputs([call, result])
}

async function normalizeCompletedMcpTool(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `mcp-${record.sourceSequence ?? record.id}`
  const name = stringField(completed.item, 'tool') ?? 'mcp_tool'
  const call = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      call_id: callId,
      arguments: JSON.stringify({
        server: completed.item.server ?? null,
        arguments: completed.item.arguments ?? {},
        connectorId: completed.item.connectorId ?? null,
        appName: completed.item.appName ?? null,
        actionName: completed.item.actionName ?? null,
      }),
    },
  }, completed.itemId), ctx)
  call.observations = call.observations.map(observation => observation.kind === 'tool.call'
    ? { ...observation, payload: { ...asRecord(observation.payload), turnId: completed.turnId, raw: completed.item } }
    : observation)

  const status = String(completed.item.status ?? '').toLowerCase()
  if (status === 'inprogress' || status === 'in_progress') return call
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(completed.item.result ?? completed.item.error ?? null),
    },
  }, completed.itemId), ctx)
  result.observations = result.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: name,
          success: status === 'completed',
          status: completed.item.status ?? null,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation)
  return mergeOutputs([call, result])
}

async function normalizeCompletedWebSearch(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `web-${record.sourceSequence ?? record.id}`
  const call = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'web_search_call',
      call_id: callId,
      status: 'completed',
      action: completed.item.action ?? { type: 'search', query: completed.item.query ?? '' },
    },
  }, completed.itemId), ctx)
  call.observations = call.observations.map(observation => observation.kind === 'tool.call'
    ? { ...observation, payload: { ...asRecord(observation.payload), turnId: completed.turnId, raw: completed.item } }
    : observation)

  if (!Array.isArray(completed.item.results)) return call
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(completed.item.results),
    },
  }, completed.itemId), ctx)
  result.observations = result.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: 'web_search',
          success: true,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation)
  return mergeOutputs([call, result])
}

async function normalizeCompletedContextCompaction(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: NonNullable<ReturnType<typeof completedTurnItem>>,
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: { type: 'context_compacted', turn_id: completed.turnId },
  }, completed.itemId), ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'context.compaction'
      ? { ...observation, payload: { ...asRecord(observation.payload), turnId: completed.turnId, raw: completed.item } }
      : observation),
  }
}

async function normalizeCompletedItem(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const completed = completedTurnItem(record)
  if (!completed) return null
  switch (completed.type) {
    case 'usermessage':
      return normalizeCompletedUserMessage(record, ctx, completed)
    case 'agentmessage':
      return normalizeCompletedAssistantMessage(record, ctx, completed)
    case 'reasoning':
      return normalizeCompletedReasoning(record, ctx, completed)
    case 'commandexecution':
      return normalizeCompletedCommand(record, ctx, completed)
    case 'dynamictoolcall':
      return normalizeCompletedDynamicTool(record, ctx, completed)
    case 'mcptoolcall':
      return normalizeCompletedMcpTool(record, ctx, completed)
    case 'websearch':
      return normalizeCompletedWebSearch(record, ctx, completed)
    case 'contextcompaction':
      return normalizeCompletedContextCompaction(record, ctx, completed)
    default:
      return normalizeCodexRecord(record, ctx)
  }
}

/**
 * 当前 Codex 同时存在 Legacy / Paginated 两套 rollout 历史格式：
 * - Legacy 的可见 Assistant 历史以 event_msg.agent_message 为权威信号；
 * - Paginated 把已物化轮次写入 event_msg.item_completed.item。
 *
 * 本层只根据原生结构化协议归一化，不根据正文猜作者/活动类型。
 * Paginated 的 canonical 事件身份使用 TurnItem.id，而不是外层 turn_id，
 * 避免同一轮内多个完成项发生覆盖。
 */
export async function normalizeCurrentCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const completed = await normalizeCompletedItem(record, ctx)
  if (completed) return completed

  const event = directAssistantEvent(record)
  if (!event) return normalizeCodexRecord(record, ctx)

  const normalized = await normalizeCodexRecord(asAssistantResponseItem(record, event, record.nativeId), ctx)
  return {
    ...normalized,
    observations: normalized.observations.map(observation => alignAssistantCandidate(observation, event)),
  }
}

export const currentCodexProtocolInternals = {
  directAssistantEvent,
  completedTurnItem,
  normalizedItemType,
}
