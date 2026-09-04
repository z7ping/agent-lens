export interface PiNativeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

interface PiNativeFactBase {
  id: string
  parentId?: string
  at: string
  nativeType: string
  raw: unknown
}

export type PiNativeFact =
  | (PiNativeFactBase & {
      kind: 'message'
      role: 'user' | 'assistant' | 'other'
      text: string
      content: unknown
      nonTextContent: unknown[]
      provider?: string
      model?: string
      stopReason?: string
      errorMessage?: string
    })
  | (PiNativeFactBase & { kind: 'thinking'; text: string })
  | (PiNativeFactBase & { kind: 'tool-call'; callId: string; name: string; input: unknown })
  | (PiNativeFactBase & { kind: 'tool-result'; callId: string; name: string; success: boolean; output: string; details?: unknown })
  | (PiNativeFactBase & { kind: 'usage'; usage: PiNativeUsage })
  | (PiNativeFactBase & { kind: 'event'; event: string; label: string; detail: string; payload: unknown })
  | (PiNativeFactBase & { kind: 'unknown'; payload: unknown })

export interface NormalizePiSessionEntryOptions {
  nativeEventId?: string
  fallbackId?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(value: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const item = value[name]
    if (typeof item === 'string' && item) return item
  }
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function timestamp(entry: Record<string, unknown>, message?: Record<string, unknown>): string {
  const value = entry.timestamp ?? message?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value !== 'string' || !value) return ''
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(raw => {
    if (typeof raw === 'string') return raw
    const block = record(raw)
    return block.type === 'text' ? stringField(block, 'text') ?? '' : ''
  }).filter(Boolean).join('\n\n')
}

function nonTextContent(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.filter(raw => {
    const block = record(raw)
    return block.type !== 'text' && block.type !== 'thinking' && block.type !== 'toolCall'
  })
}

function compact(value: unknown, max = 240): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) ?? '' } catch { text = String(value ?? '') }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function normalizePiUsage(value: unknown): PiNativeUsage | null {
  const usage = record(value)
  if (!Object.keys(usage).length) return null
  const inputTokens = finiteNumber(usage.input ?? usage.inputTokens) ?? 0
  const outputTokens = finiteNumber(usage.output ?? usage.outputTokens) ?? 0
  const cacheReadTokens = finiteNumber(usage.cacheRead ?? usage.cache_read ?? usage.cacheReadTokens) ?? 0
  const cacheWriteTokens = finiteNumber(usage.cacheWrite ?? usage.cache_write ?? usage.cacheWriteTokens) ?? 0
  const totalTokens = finiteNumber(usage.totalTokens ?? usage.total_tokens)
    ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const costRecord = record(usage.cost)
  const cost = {
    ...(finiteNumber(costRecord.input) === undefined ? {} : { input: finiteNumber(costRecord.input)! }),
    ...(finiteNumber(costRecord.output) === undefined ? {} : { output: finiteNumber(costRecord.output)! }),
    ...(finiteNumber(costRecord.cacheRead ?? costRecord.cache_read) === undefined ? {} : { cacheRead: finiteNumber(costRecord.cacheRead ?? costRecord.cache_read)! }),
    ...(finiteNumber(costRecord.cacheWrite ?? costRecord.cache_write) === undefined ? {} : { cacheWrite: finiteNumber(costRecord.cacheWrite ?? costRecord.cache_write)! }),
    ...(finiteNumber(costRecord.total) === undefined ? {} : { total: finiteNumber(costRecord.total)! }),
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(Object.keys(cost).length ? { cost } : {}),
  }
}

function usageFact(base: PiNativeFactBase, usage: unknown, suffix = 'usage'): PiNativeFact | null {
  const normalized = normalizePiUsage(usage)
  if (!normalized) return null
  return {
    ...base,
    id: `${base.id}:${suffix}`,
    parentId: base.id,
    kind: 'usage',
    usage: normalized,
  }
}

export function normalizePiSessionEntry(
  raw: unknown,
  options: NormalizePiSessionEntryOptions = {},
): PiNativeFact[] {
  const entry = record(raw)
  const type = stringField(entry, 'type') ?? 'unknown'
  const nativeEntryId = stringField(entry, 'id')
  const id = options.nativeEventId ?? nativeEntryId ?? options.fallbackId ?? `${type}:anonymous`
  const parentId = stringField(entry, 'parentId')
  const base: PiNativeFactBase = {
    id,
    ...(parentId ? { parentId } : {}),
    at: timestamp(entry),
    nativeType: type,
    raw,
  }
  const facts: PiNativeFact[] = []

  if (type === 'session') {
    facts.push({ ...base, kind: 'event', event: 'session.started', label: '会话开始', detail: stringField(entry, 'cwd') ?? '', payload: raw })
    return facts
  }

  if (type === 'message') {
    const message = record(entry.message)
    const messageBase: PiNativeFactBase = { ...base, at: timestamp(entry, message) }
    const role = stringField(message, 'role') ?? 'other'
    const content = message.content ?? message.text
    if (role === 'user') {
      facts.push({ ...messageBase, kind: 'message', role: 'user', text: textFromContent(content), content, nonTextContent: nonTextContent(content) })
      return facts
    }
    if (role === 'assistant') {
      const provider = stringField(message, 'provider')
      const model = stringField(message, 'model')
      const stopReason = stringField(message, 'stopReason', 'stop_reason')
      const errorMessage = stringField(message, 'errorMessage', 'error_message')
      facts.push({
        ...messageBase,
        kind: 'message',
        role: 'assistant',
        text: textFromContent(content),
        content,
        nonTextContent: nonTextContent(content),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      })
      const blocks = Array.isArray(content) ? content.map(record) : []
      const thinking = blocks
        .filter(block => block.type === 'thinking')
        .map(block => stringField(block, 'thinking', 'text') ?? '')
        .filter(Boolean)
      if (thinking.length) facts.push({ ...messageBase, id: `${id}:thinking`, parentId: id, kind: 'thinking', text: thinking.join('\n\n') })
      for (const block of blocks.filter(item => item.type === 'toolCall')) {
        const callId = stringField(block, 'id')
        if (!callId) continue
        facts.push({
          ...messageBase,
          id: `${id}:tool:${callId}`,
          parentId: id,
          kind: 'tool-call',
          callId,
          name: stringField(block, 'name') ?? 'unknown',
          input: block.arguments ?? block.args ?? {},
        })
      }
      const usage = usageFact(messageBase, message.usage)
      if (usage) facts.push(usage)
      return facts
    }
    if (role === 'tool' || role === 'toolResult') {
      const callId = stringField(message, 'toolCallId') ?? `pi-result-${id}`
      facts.push({
        ...messageBase,
        kind: 'tool-result',
        callId,
        name: stringField(message, 'toolName') ?? 'unknown',
        success: message.isError !== true,
        output: textFromContent(content),
        ...(message.details === undefined ? {} : { details: message.details }),
      })
      const usage = usageFact(messageBase, message.usage)
      if (usage) facts.push(usage)
      return facts
    }
    facts.push({ ...messageBase, kind: 'message', role: 'other', text: textFromContent(content), content, nonTextContent: nonTextContent(content) })
    return facts
  }

  if (type === 'model_change') {
    const provider = stringField(entry, 'provider') ?? 'unknown'
    const model = stringField(entry, 'modelId', 'model') ?? 'unknown'
    facts.push({ ...base, kind: 'event', event: 'model.changed', label: '模型已切换', detail: [provider, model].filter(Boolean).join(' / '), payload: { provider, model } })
  } else if (type === 'thinking_level_change') {
    const level = stringField(entry, 'thinkingLevel', 'level') ?? 'unknown'
    facts.push({ ...base, kind: 'event', event: 'thinking.level.changed', label: '推理级别已切换', detail: level, payload: { level } })
  } else if (type === 'compaction') {
    const payload = {
      phase: 'end',
      ...(finiteNumber(entry.tokensBefore) === undefined ? {} : { tokensBefore: finiteNumber(entry.tokensBefore)! }),
      ...(stringField(entry, 'summary') ? { summary: stringField(entry, 'summary')! } : {}),
      ...(stringField(entry, 'firstKeptEntryId') ? { firstKeptEntryId: stringField(entry, 'firstKeptEntryId')! } : {}),
    }
    facts.push({ ...base, kind: 'event', event: 'context.compaction', label: '上下文已压缩', detail: [payload.tokensBefore === undefined ? '' : `${payload.tokensBefore} tokens`, 'summary' in payload ? String(payload.summary) : ''].filter(Boolean).join(' · '), payload })
    const usage = usageFact(base, entry.usage)
    if (usage) facts.push(usage)
  } else if (type === 'branch_summary') {
    const summary = stringField(entry, 'summary') ?? ''
    const fromId = stringField(entry, 'fromId')
    const payload = { text: summary, ...(fromId ? { branchFromEntryId: fromId } : {}) }
    facts.push({ ...base, kind: 'event', event: 'context.summary', label: '分支摘要', detail: summary, payload })
    const usage = usageFact(base, entry.usage)
    if (usage) facts.push(usage)
  } else if (type === 'session_info') {
    const name = stringField(entry, 'name')?.trim() ?? ''
    facts.push({ ...base, kind: 'event', event: 'session.info', label: '会话信息已更新', detail: name, payload: { ...(name ? { name } : {}) } })
  } else if (type === 'custom') {
    const customType = stringField(entry, 'customType', 'name', 'event') ?? 'custom'
    facts.push({ ...base, kind: 'event', event: 'pi.custom', label: `Pi 自定义事件 · ${customType}`, detail: compact(entry.data ?? entry.payload), payload: raw })
  } else if (type === 'custom_message') {
    facts.push({ ...base, kind: 'event', event: 'pi.custom_message', label: 'Pi 扩展消息', detail: textFromContent(entry.content ?? entry.message ?? entry.text) || compact(entry), payload: raw })
  } else if (type === 'label') {
    const label = stringField(entry, 'label', 'name') ?? ''
    facts.push({ ...base, kind: 'event', event: 'pi.label', label: 'Pi 标签', detail: label, payload: raw })
  } else if (type === 'bash' || type === 'bash_result') {
    facts.push({ ...base, kind: 'event', event: `pi.${type}`, label: type === 'bash' ? 'Pi Bash' : 'Pi Bash 结果', detail: compact(entry.command ?? entry.output ?? entry), payload: raw })
  } else {
    facts.push({ ...base, kind: 'unknown', payload: raw })
  }
  return facts
}
