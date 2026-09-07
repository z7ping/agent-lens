import type {
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

function stringField(record: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export async function normalizePaginatedFunctionOutput(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput | null> {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  if (entry.type !== 'event_msg' || payload.type !== 'item_completed') return null

  const item = asRecord(payload.item)
  const itemType = typeof item.type === 'string' ? item.type.replace(/[_-]/g, '').toLowerCase() : ''
  if (itemType !== 'functioncalloutput') return null

  const callId = stringField(item, 'id')
  if (!callId) return normalizeCodexRecord(record, ctx)
  const name = stringField(item, 'name') ?? 'function_call'
  const outputValue = item.output
  const text = typeof outputValue === 'string'
    ? outputValue
    : messageText(outputValue) || JSON.stringify(outputValue ?? null)

  const normalized = await normalizeCodexRecord({
    ...record,
    nativeId: callId,
    payload: {
      ...envelope,
      entry: {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: text,
        },
      },
    },
  }, ctx)

  const turnId = stringField(payload, 'turn_id', 'turnId')
  return {
    ...normalized,
    observations: normalized.observations.map(observation => observation.kind === 'tool.result'
      ? {
          ...observation,
          payload: {
            ...asRecord(observation.payload),
            nativeToolName: name,
            ...(stringField(item, 'namespace') ? { namespace: stringField(item, 'namespace') } : {}),
            ...(turnId ? { turnId } : {}),
            sourceSignal: 'event_msg.item_completed.FunctionCallOutput',
            raw: item,
          },
        }
      : observation),
  }
}
