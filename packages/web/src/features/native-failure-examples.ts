import type { NativeSessionSummaryDto, NativeReviewWindowDto } from '@agent-lens/protocol'
import { nativeReviewNodeIsFailure } from '../client/native-review-adapter'

const MAX_TEXT = 8192

export interface NativeFailureExample {
  id: string
  sessionId: string
  sourceId: string
  title: string | null
  projectName: string | null
  at: string
  ordinal: number
  kind: 'tool' | 'runtime'
  toolName: string | null
  nativeCallId: string | null
  nativeEventId: string | null
  prompt: string | null
  input: string | null
  error: string
  truncated: boolean
  contextPartial: boolean
  observationIds: string[]
  evidenceIds: string[]
}

function text(value: unknown): { value: string; truncated: boolean } {
  const original = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return {value: original.slice(0, MAX_TEXT), truncated: original.length > MAX_TEXT}
}

/** 使用与原生统计相同的明确失败判据；不靠 error 关键词猜失败。 */
export function nativeFailureExamples(session: NativeSessionSummaryDto, window: NativeReviewWindowDto,
  toolName?: string): NativeFailureExample[] {
  return window.interactions.flatMap(turn => {
    const user = turn.nodes.find(node => node.type === 'message' && node.role === 'user')
    const prompt = user?.type === 'message' ? text(user.text) : undefined
    return turn.nodes.flatMap(node => {
      // 复用窗口统计判据；结果落在下一分片时仍保留明确失败，不猜配对输入。
      if (!nativeReviewNodeIsFailure(node)) return []
      const tool = node.type === 'tool' ? node : undefined
      const orphan = node.type==='event'&&node.kind==='tool.result'
        && node.payload&&typeof node.payload==='object'&&!Array.isArray(node.payload) ? node.payload : undefined
      const name = tool?.name ?? (typeof orphan?.nativeToolName==='string'?orphan.nativeToolName:null)
      if(toolName&&name!==toolName)return []
      const input = tool?.input === undefined ? undefined : text(tool.input)
      const error = text(tool ? tool.output : orphan ? orphan.output??orphan.result??orphan : node.type === 'event' ? node.payload : null)
      return [{
        id:node.id,sessionId:session.id,sourceId:session.sourceId,
        title:session.title ?? null,projectName:session.projectName ?? null,
        at:node.at,ordinal:turn.ordinal,kind:tool||orphan?'tool' as const:'runtime' as const,
        toolName:name,prompt:prompt?.value ?? null,input:input?.value ?? null,
        nativeCallId:tool?.callId??node.nativeCallId??null,nativeEventId:node.nativeEventId??null,
        error:error.value,
        truncated:Boolean(prompt?.truncated || input?.truncated || error.truncated),
        contextPartial:Boolean(window.turnFragment==='partial' || turn.nodesTruncated || !prompt || orphan),
        observationIds:[...node.observationIds],evidenceIds:node.evidence.map(item=>item.id),
      }]
    })
  })
}

