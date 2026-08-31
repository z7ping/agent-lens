import { normalizePiSessionEntry, type PiLiveSnapshotDto, type PiNativeFact, type PiNativeUsage } from '@agent-lens/protocol'

export type PiLiveHistoryItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; at: string }
  | { id: string; kind: 'thinking'; text: string; at: string }
  | { id: string; kind: 'tool'; callId: string; name: string; summary: string; output: string; status: 'success' | 'error' | 'unknown'; at: string; durationMs?: number | undefined }
  | { id: string; kind: 'usage'; usage: PiNativeUsage; at: string }
  | { id: string; kind: 'lifecycle'; event: string; label: string; detail: string; at: string; nativeType?: string | undefined }

function elapsedMs(start: string, end: string): number | undefined {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined
  return endMs - startMs
}

function compact(value: unknown, max = 160): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) ?? '' } catch { text = String(value ?? '') }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function resultOutput(fact: Extract<PiNativeFact, { kind: 'tool-result' }>): string {
  const details = fact.details === undefined ? '' : compact(fact.details, 1200)
  return [fact.output, details ? `Details: ${details}` : ''].filter(Boolean).join('\n\n')
}

function messageText(fact: Extract<PiNativeFact, { kind: 'message' }>): string {
  if (fact.text.trim()) return fact.text
  if (fact.nonTextContent.length) return `包含 ${fact.nonTextContent.length} 个非文本内容块`
  return ''
}

export function projectPiLiveHistory(snapshot: PiLiveSnapshotDto | null): PiLiveHistoryItem[] {
  if (!snapshot) return []
  const facts = snapshot.entries.flatMap((entry, index) => normalizePiSessionEntry(entry, { fallbackId: `snapshot:${index}` }))
  const results = new Map<string, Extract<PiNativeFact, { kind: 'tool-result' }>>()
  for (const fact of facts) if (fact.kind === 'tool-result') results.set(fact.callId, fact)
  const consumedResults = new Set<string>()
  const items: PiLiveHistoryItem[] = []

  for (const fact of facts) {
    if (fact.kind === 'message') {
      if (fact.role === 'user' || fact.role === 'assistant') {
        const text = messageText(fact)
        if (text) items.push({ id: fact.id, kind: 'message', role: fact.role, text, at: fact.at })
        if (fact.role === 'assistant' && (fact.stopReason || fact.errorMessage)) {
          const failed = fact.stopReason === 'error' || Boolean(fact.errorMessage)
          items.push({
            id: `${fact.id}:stop`,
            kind: 'lifecycle',
            event: failed ? 'assistant.error' : 'assistant.stop',
            label: failed ? 'Pi 响应错误' : 'Pi 响应结束',
            detail: [fact.stopReason, fact.errorMessage].filter(Boolean).join(' · '),
            at: fact.at,
            nativeType: fact.nativeType,
          })
        }
      } else {
        items.push({ id: fact.id, kind: 'lifecycle', event: 'pi.message.other', label: 'Pi 特殊消息', detail: compact(fact.raw), at: fact.at, nativeType: fact.nativeType })
      }
      continue
    }
    if (fact.kind === 'thinking') {
      if (fact.text.trim()) items.push({ id: fact.id, kind: 'thinking', text: fact.text, at: fact.at })
      continue
    }
    if (fact.kind === 'tool-call') {
      const paired = results.get(fact.callId)
      if (paired) consumedResults.add(fact.callId)
      items.push({
        id: fact.id,
        kind: 'tool',
        callId: fact.callId,
        name: fact.name || paired?.name || 'tool',
        summary: compact(fact.input),
        output: paired ? resultOutput(paired) : '',
        status: paired ? (paired.success ? 'success' : 'error') : 'unknown',
        at: fact.at,
        durationMs: paired ? elapsedMs(fact.at, paired.at) : undefined,
      })
      continue
    }
    if (fact.kind === 'tool-result') {
      if (consumedResults.has(fact.callId)) continue
      items.push({
        id: fact.id,
        kind: 'tool',
        callId: fact.callId,
        name: fact.name,
        summary: '未找到对应 Tool Call，保留原生 Tool Result 事实',
        output: resultOutput(fact),
        status: fact.success ? 'success' : 'error',
        at: fact.at,
      })
      continue
    }
    if (fact.kind === 'usage') {
      items.push({ id: fact.id, kind: 'usage', usage: fact.usage, at: fact.at })
      continue
    }
    if (fact.kind === 'event') {
      items.push({ id: fact.id, kind: 'lifecycle', event: fact.event, label: fact.label, detail: fact.detail, at: fact.at, nativeType: fact.nativeType })
      continue
    }
    items.push({ id: fact.id, kind: 'lifecycle', event: 'native.unknown', label: 'Pi 原生事件', detail: fact.nativeType, at: fact.at, nativeType: fact.nativeType })
  }
  return items
}
