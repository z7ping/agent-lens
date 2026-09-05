import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import { assistantMessageProvenance, userMessageProvenance } from './provenance'

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
  const { nativeId: _outerNativeId, ...withoutNativeId } = record
  return {
    ...withoutNativeId,
    ...(nativeId ? { nativeId } : {}),
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

export interface CodexCompletedTurnItem {
  turnId: string
  item: Record<string, any>
  itemId?: string
  type: string
}

export function completedTurnItem(record: SourceRecord): CodexCompletedTurnItem | null {
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

async function normalizeUserMessage(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const text = messageText(completed.item.content)
  const attachments = userItemAttachments(completed.item.content)
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      ...(attachments.length ? { attachments } : {}),
      turn_id: completed.turnId,
    },
  }, completed.itemId), ctx)

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

async function normalizeAgentMessage(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const text = messageText(completed.item.content)
  if (!text) return normalizeCodexRecord(record, ctx)
  const phase = stringField(completed.item, 'phase')
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      ...(phase ? { phase } : {}),
    },
  }, completed.itemId), ctx)

  return {
    ...output,
    observations: output.observations.map(observation => {
      if (observation.kind !== 'message.assistant' && observation.kind !== 'message.commentary') return observation
      const original = asRecord(observation.payload)
      const { content: _syntheticContent, provenance: _legacyProvenance, ...visible } = original
      return {
        ...observation,
        payload: {
          ...visible,
          provenance: assistantMessageProvenance('assistant', 'event_msg.item_completed.AgentMessage'),
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    }),
  }
}

async function normalizeReasoning(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const summary = Array.isArray(completed.item.summary_text)
    ? completed.item.summary_text.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const rawContent = Array.isArray(completed.item.raw_content)
    ? completed.item.raw_content.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const text = (summary.length ? summary : rawContent).join('\n\n')
  if (!text) return normalizeCodexRecord(record, ctx)

  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: { type: 'agent_reasoning', text, turn_id: completed.turnId },
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

function decorateToolCall(
  observation: ObservationCandidate,
  completed: CodexCompletedTurnItem,
): ObservationCandidate {
  return observation.kind === 'tool.call'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation
}

function decorateToolResult(
  observation: ObservationCandidate,
  completed: CodexCompletedTurnItem,
  options: { nativeToolName: string; success: boolean },
): ObservationCandidate {
  return observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: options.nativeToolName,
          success: options.success,
          status: completed.item.status ?? null,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation
}

function commandOutput(item: Record<string, any>): string {
  for (const key of ['formatted_output', 'aggregated_output']) {
    if (typeof item[key] === 'string' && item[key]) return item[key]
  }
  return [item.stdout, item.stderr]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
    .join('\n')
}

async function normalizeCommandExecution(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
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
  call.observations = call.observations.map(observation => decorateToolCall(observation, completed))

  const status = String(completed.item.status ?? '').toLowerCase()
  if (status === 'in_progress' || status === 'inprogress') return call

  const exitCode = typeof completed.item.exit_code === 'number' ? completed.item.exit_code : undefined
  const outputText = `${exitCode === undefined ? '' : `Exit code: ${exitCode}\n`}Output:\n${commandOutput(completed.item)}`
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output: outputText },
  }, completed.itemId), ctx)
  const failed = status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0)
  result.observations = result.observations.map(observation => decorateToolResult(
    observation,
    completed,
    { nativeToolName: 'command_execution', success: !failed },
  ))
  return mergeOutputs([call, result])
}

async function normalizeDynamicToolCall(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
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
  call.observations = call.observations.map(observation => decorateToolCall(observation, completed))

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
  const success = typeof completed.item.success === 'boolean'
    ? completed.item.success
    : status === 'completed'
  result.observations = result.observations.map(observation => decorateToolResult(
    observation,
    completed,
    { nativeToolName: name, success },
  ))
  return mergeOutputs([call, result])
}

async function normalizeMcpToolCall(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
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
  call.observations = call.observations.map(observation => decorateToolCall(observation, completed))

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
  result.observations = result.observations.map(observation => decorateToolResult(
    observation,
    completed,
    { nativeToolName: name, success: status === 'completed' },
  ))
  return mergeOutputs([call, result])
}

async function normalizeWebSearch(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
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
  call.observations = call.observations.map(observation => decorateToolCall(observation, completed))

  if (!Array.isArray(completed.item.results)) return call
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(completed.item.results),
    },
  }, completed.itemId), ctx)
  result.observations = result.observations.map(observation => decorateToolResult(
    observation,
    completed,
    { nativeToolName: 'web_search', success: true },
  ))
  return mergeOutputs([call, result])
}

async function normalizeContextCompaction(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: { type: 'context_compacted', turn_id: completed.turnId },
  }, completed.itemId), ctx)
  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'context.compaction'
      ? {
          ...observation,
          payload: {
            ...asRecord(observation.payload),
            turnId: completed.turnId,
            raw: completed.item,
          },
        }
      : observation),
  }
}

/**
 * Normalize Codex Paginated history. Returns null when the record is not an
 * event_msg.item_completed record, allowing the legacy parser to handle it.
 * Unsupported TurnItem variants intentionally remain raw/unknown until their
 * semantics are mapped explicitly.
 */
export async function normalizePaginatedCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const completed = completedTurnItem(record)
  if (!completed) return null

  switch (completed.type) {
    case 'usermessage': return normalizeUserMessage(record, ctx, completed)
    case 'agentmessage': return normalizeAgentMessage(record, ctx, completed)
    case 'reasoning': return normalizeReasoning(record, ctx, completed)
    case 'commandexecution': return normalizeCommandExecution(record, ctx, completed)
    case 'dynamictoolcall': return normalizeDynamicToolCall(record, ctx, completed)
    case 'mcptoolcall': return normalizeMcpToolCall(record, ctx, completed)
    case 'websearch': return normalizeWebSearch(record, ctx, completed)
    case 'contextcompaction': return normalizeContextCompaction(record, ctx, completed)
    default: return normalizeCodexRecord(record, ctx)
  }
}

export const paginatedProtocolInternals = {
  completedTurnItem,
  normalizedItemType,
  userItemAttachments,
}
