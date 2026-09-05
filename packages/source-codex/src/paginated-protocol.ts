import type {
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { messageText, type CodexStoredEnvelope } from './format'
import { normalizeCodexRecord } from './normalize'
import {
  assistantMessageProvenance,
  contextClassification,
  userMessageProvenance,
} from './provenance'

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

async function normalizeStructuredCompletedItem(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
  kind: ObservationCandidate['kind'],
  payload: Record<string, unknown>,
  extraIdentity: Partial<ObservationCandidate['identityHints']> = {},
): Promise<NormalizedSourceOutput> {
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: completed.turnId,
      item: completed.item,
    },
  }, completed.itemId), ctx)

  return {
    ...output,
    observations: output.observations.map(observation => observation.kind === 'unknown'
      ? {
          ...observation,
          kind,
          payload: {
            ...payload,
            ...(completed.turnId ? { turnId: completed.turnId } : {}),
            raw: completed.item,
          },
          identityHints: {
            ...observation.identityHints,
            ...extraIdentity,
          },
        }
      : observation),
  }
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

async function normalizePlan(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  return normalizeStructuredCompletedItem(record, ctx, completed, 'message.commentary', {
    text: stringField(completed.item, 'text') ?? '',
    phase: 'plan',
    plan: true,
    provenance: assistantMessageProvenance('assistant', 'event_msg.item_completed.Plan'),
  })
}

async function normalizeHookPrompt(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const fragments = Array.isArray(completed.item.fragments)
    ? completed.item.fragments.map(asRecord)
    : []
  const text = fragments
    .map(fragment => stringField(fragment, 'text') ?? '')
    .filter(Boolean)
    .join('\n\n')
  const classification = contextClassification('hook', text)
  return normalizeStructuredCompletedItem(record, ctx, completed, 'context.injected', {
    sourceType: 'event_msg.item_completed.HookPrompt',
    injectedContext: true,
    role: 'hook',
    label: 'Hook 提示',
    injectedKind: 'application',
    text,
    provenance: {
      ...classification.provenance,
      sourceSignal: 'event_msg.item_completed.HookPrompt',
      injectedKind: 'application',
    },
    fragments,
  })
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

async function normalizeFunctionCallOutput(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `function-output-${record.sourceSequence ?? record.id}`
  const name = stringField(completed.item, 'name') ?? 'function_call'
  const output = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: typeof completed.item.output === 'string'
        ? completed.item.output
        : JSON.stringify(completed.item.output ?? null),
    },
  }, completed.itemId), ctx)
  output.observations = output.observations.map(observation => observation.kind === 'tool.result'
    ? {
        ...observation,
        payload: {
          ...asRecord(observation.payload),
          nativeToolName: name,
          namespace: completed.item.namespace ?? null,
          turnId: completed.turnId,
          raw: completed.item,
        },
      }
    : observation)
  return output
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

async function normalizeCollabAgentToolCall(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const callId = completed.itemId ?? `collab-${record.sourceSequence ?? record.id}`
  const tool = stringField(completed.item, 'tool') ?? 'collab_agent'
  const nativeToolName = `collab_agent.${tool}`
  const input = {
    senderThreadId: completed.item.sender_thread_id ?? completed.item.senderThreadId ?? null,
    receiverThreadIds: completed.item.receiver_thread_ids ?? completed.item.receiverThreadIds ?? [],
    receiverAgents: completed.item.receiver_agents ?? completed.item.receiverAgents ?? [],
    prompt: completed.item.prompt ?? null,
    model: completed.item.model ?? null,
    reasoningEffort: completed.item.reasoning_effort ?? completed.item.reasoningEffort ?? null,
  }
  const call = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: nativeToolName,
      call_id: callId,
      arguments: JSON.stringify(input),
    },
  }, completed.itemId), ctx)
  call.observations = call.observations.map(observation => decorateToolCall(observation, completed))

  const status = normalizedItemType(completed.item.status)
  if (status === 'inprogress') return call

  const success = status === 'completed'
  const result = await normalizeCodexRecord(syntheticRecord(record, {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        status: completed.item.status ?? null,
        agentsStates: completed.item.agents_states ?? completed.item.agentsStates ?? {},
      }),
    },
  }, completed.itemId), ctx)
  result.observations = result.observations.map(observation => decorateToolResult(
    observation,
    completed,
    { nativeToolName, success },
  ))
  return mergeOutputs([call, result])
}

async function normalizeSubAgentActivity(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  const activity = normalizedItemType(completed.item.kind)
  const nativeActorId = stringField(completed.item, 'agent_thread_id', 'agentThreadId')
  const payload = {
    activityKind: completed.item.kind ?? null,
    agentThreadId: nativeActorId ?? null,
    agentPath: completed.item.agent_path ?? completed.item.agentPath ?? null,
  }
  const identity = nativeActorId
    ? { nativeActorId, actorRole: 'subagent' as const }
    : { actorRole: 'subagent' as const }

  if (activity === 'started') {
    return normalizeStructuredCompletedItem(record, ctx, completed, 'subagent.spawn', payload, identity)
  }
  if (activity === 'completed' || activity === 'interrupted') {
    return normalizeStructuredCompletedItem(record, ctx, completed, 'subagent.end', payload, identity)
  }
  return normalizeStructuredCompletedItem(record, ctx, completed, 'session.lifecycle', {
    event: 'subagent.interacted',
    ...payload,
  }, identity)
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

async function normalizeReviewMode(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
  phase: 'entered' | 'exited',
): Promise<NormalizedSourceOutput> {
  return normalizeStructuredCompletedItem(record, ctx, completed, 'session.lifecycle', phase === 'entered'
    ? {
        event: 'review.entered',
        reviewMode: true,
        target: completed.item.target ?? null,
        userFacingHint: completed.item.user_facing_hint ?? completed.item.userFacingHint ?? null,
      }
    : {
        event: 'review.exited',
        reviewMode: false,
        reviewOutput: completed.item.review_output ?? completed.item.reviewOutput ?? null,
      })
}

async function normalizeFileChange(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  return normalizeStructuredCompletedItem(record, ctx, completed, 'artifact.action', {
    action: 'file.change',
    changes: completed.item.changes ?? {},
    status: completed.item.status ?? null,
    autoApproved: completed.item.auto_approved ?? completed.item.autoApproved ?? null,
    stdout: completed.item.stdout ?? null,
    stderr: completed.item.stderr ?? null,
  })
}

async function normalizeImageView(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  return normalizeStructuredCompletedItem(record, ctx, completed, 'artifact.action', {
    action: 'image.view',
    path: completed.item.path ?? null,
  })
}

async function normalizeImageGeneration(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  completed: CodexCompletedTurnItem,
): Promise<NormalizedSourceOutput> {
  return normalizeStructuredCompletedItem(record, ctx, completed, 'artifact.action', {
    action: 'image.generate',
    status: completed.item.status ?? null,
    revisedPrompt: completed.item.revised_prompt ?? completed.item.revisedPrompt ?? null,
    result: completed.item.result ?? null,
    savedPath: completed.item.saved_path ?? completed.item.savedPath ?? null,
  })
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
 *
 * Current Codex-owned TurnItem variants are mapped to explicit Canonical kinds.
 * Extension remains raw/unknown because its semantic owner and payload schema are
 * extension-defined; guessing it here would be less correct than preserving raw evidence.
 */
export async function normalizePaginatedCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const completed = completedTurnItem(record)
  if (!completed) return null

  switch (completed.type) {
    case 'usermessage': return normalizeUserMessage(record, ctx, completed)
    case 'functioncalloutput': return normalizeFunctionCallOutput(record, ctx, completed)
    case 'hookprompt': return normalizeHookPrompt(record, ctx, completed)
    case 'agentmessage': return normalizeAgentMessage(record, ctx, completed)
    case 'plan': return normalizePlan(record, ctx, completed)
    case 'reasoning': return normalizeReasoning(record, ctx, completed)
    case 'commandexecution': return normalizeCommandExecution(record, ctx, completed)
    case 'dynamictoolcall': return normalizeDynamicToolCall(record, ctx, completed)
    case 'collabagenttoolcall': return normalizeCollabAgentToolCall(record, ctx, completed)
    case 'subagentactivity': return normalizeSubAgentActivity(record, ctx, completed)
    case 'mcptoolcall': return normalizeMcpToolCall(record, ctx, completed)
    case 'websearch': return normalizeWebSearch(record, ctx, completed)
    case 'imageview': return normalizeImageView(record, ctx, completed)
    case 'imagegeneration': return normalizeImageGeneration(record, ctx, completed)
    case 'enteredreviewmode': return normalizeReviewMode(record, ctx, completed, 'entered')
    case 'exitedreviewmode': return normalizeReviewMode(record, ctx, completed, 'exited')
    case 'filechange': return normalizeFileChange(record, ctx, completed)
    case 'contextcompaction': return normalizeContextCompaction(record, ctx, completed)
    default: return normalizeCodexRecord(record, ctx)
  }
}

export const paginatedProtocolInternals = {
  completedTurnItem,
  normalizedItemType,
  userItemAttachments,
}
