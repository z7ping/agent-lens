import type { NativeSessionSummaryDto, NativeReviewWindowDto } from '@agent-lens/protocol'
import { AgentLensApi, rangeStart, type QueryFilters } from '../client/api'
import { nativeReviewNodeIsFailure } from '../client/native-review-adapter'

const MAX_EXAMPLES = 20
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

type FailureApi = Pick<AgentLensApi,'nativeSessions'|'nativeReviewById'>

/** 每次推进最多一个有界目录页或原生 Review 页，正文只留在本次抽屉内存。 */
export class NativeFailureScanner {
  private sessions: NativeSessionSummaryDto[] = []
  private catalogCursor: string | undefined
  private catalogDone = false
  private active: NativeSessionSummaryDto | undefined
  private reviewCursor: string | undefined
  private readonly from: string | undefined
  private readonly seen = new Set<string>()
  private readonly checked = new Set<string>()
  private readonly cursors = new Map<string,string>()
  readonly examples: NativeFailureExample[] = []
  pages = 0
  checkedSessions = 0
  skippedSessions = 0
  lastIssue = ''
  constructor(private readonly api: FailureApi, private readonly filters: QueryFilters,
    private readonly toolName?: string) {
    this.from = rangeStart(filters.range)
    if (filters.sourceIds?.length === 0) this.catalogDone = true
  }
  get finished() { return this.catalogDone && !this.active && !this.sessions.length }
  get capped() { return this.examples.length >= MAX_EXAMPLES }
  async next(signal: AbortSignal) {
    if (this.finished || this.capped) return
    if (!this.active) {
      if (!this.sessions.length && !this.catalogDone) {
        const page = await this.api.nativeSessions({limit:5,
          ...(this.filters.sourceIds?.length===1?{sourceId:this.filters.sourceIds[0]!}:{}),
          ...(this.filters.projectId?{projectId:this.filters.projectId}:{}),
          ...(this.catalogCursor?{cursor:this.catalogCursor}:{}),signal})
        if (signal.aborted) return
        if (page.hasMore && (!page.nextCursor || page.nextCursor===this.catalogCursor)) {
          throw new Error('native-failure-cursor-stalled')
        }
        this.sessions = page.items.filter(session =>
          (!this.filters.sourceIds || this.filters.sourceIds.includes(session.sourceId))
          && (!this.from || session.lastActivityAt>=this.from)
          && !(session.metricsState==='complete' && session.metrics?.errorCount===0))
          .sort((left,right)=>(right.metrics?.errorCount??0)-(left.metrics?.errorCount??0))
        this.catalogCursor = page.nextCursor
        this.catalogDone = !page.hasMore
        return
      }
      this.active = this.sessions.shift()
      if (!this.active) return
      this.reviewCursor = this.cursors.get(this.active.id)
      if(!this.checked.has(this.active.id)){
        this.checked.add(this.active.id)
        this.checkedSessions++
      }
    }
    const session = this.active
    const result = await this.api.nativeReviewById(session.id,{
      turnLimit:2,...(this.reviewCursor?{cursor:this.reviewCursor}:{}),signal})
    if (signal.aborted) return
    this.pages++
    if (result.state!=='available') {
      if(result.state==='drifted'||result.state==='unavailable'){
        for(let index=this.examples.length-1;index>=0;index--){
          const example=this.examples[index]!
          if(example.sessionId===session.id){
            this.seen.delete(`${example.sessionId}:${example.id}`)
            this.examples.splice(index,1)
          }
        }
      }
      this.skippedSessions++
      this.lastIssue = result.reason
      this.active = undefined
      return
    }
    for (const example of nativeFailureExamples(session,result,this.toolName)) {
      const key = `${example.sessionId}:${example.id}`
      if (!this.seen.has(key) && this.examples.length<MAX_EXAMPLES) {
        this.seen.add(key)
        this.examples.push(example)
      }
    }
    if (result.hasMore) {
      if (!result.nextCursor || result.nextCursor===this.reviewCursor) {
        throw new Error('native-failure-cursor-stalled')
      }
      this.cursors.set(session.id,result.nextCursor)
      this.sessions.push(session)
    } else {
      this.cursors.delete(session.id)
    }
    // 会话间轮转，避免一个超长会话挡住其他已有失败的会话。
    this.active = undefined
  }
}
