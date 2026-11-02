/**
 * Assemble the Hermes /v1/runs SSE vocabulary before publishing Live events.
 * The Runs endpoint is NOT /api/sessions/:id/chat/stream: its assistant text
 * uses message.delta and the authoritative reply is run.completed.output.
 *
 * Derived events retain the run's exact source event separately in the Live
 * channel. Stable per-run segment ids let the shared transcript reducer upsert
 * deltas rather than displaying one bubble per SSE sequence.
 */
export class HermesRunTranscriptAssembler {
  private segment = 0
  private activeId: string | undefined
  private segmentText = ''
  private lastInterim: { id: string; text: string } | undefined
  private pendingReasoning: Readonly<Record<string, unknown>>[] = []
  private reasoningSegment = 0
  private toolSequence = 0
  private activeTools: Array<{ id: string; name: string }> = []

  private reasoningId(): string {
    return `hermes:${this.runId}:reasoning:${this.reasoningSegment}`
  }

  private toolEvent(event: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
    const tool = typeof event.tool === 'string' ? event.tool
      : typeof event.tool_name === 'string' ? event.tool_name : 'tool'
    const nativeId = typeof event.tool_call_id === 'string' && event.tool_call_id
      ? event.tool_call_id : typeof event.call_id === 'string' && event.call_id
        ? event.call_id : undefined
    if (name === 'tool.started') {
      const id = nativeId || `hermes:${this.runId}:tool:${++this.toolSequence}`
      this.activeTools.push({ id, name: tool })
      return { ...event, tool_call_id: id }
    }
    const index = nativeId
      ? this.activeTools.findIndex(item => item.id === nativeId)
      : this.activeTools.findIndex(item => item.name === tool)
    const match = index >= 0 ? this.activeTools.splice(index, 1)[0] : undefined
    // If a terminal event was replayed without its start, keep its native
    // identity or mint a distinct orphan id; never update an unrelated tool.
    return { ...event, tool_call_id: nativeId || match?.id
      || `hermes:${this.runId}:tool:orphan:${++this.toolSequence}` }
  }

  constructor(private readonly runId: string) {}

  private messageId(): string {
    return this.activeId ??= `hermes:${this.runId}:segment:${this.segment}`
  }

  private advance(): void {
    this.segment += 1
    this.activeId = undefined
    this.segmentText = ''
  }

  private releaseReasoning(visibleText = ''): Readonly<Record<string, unknown>>[] {
    const result = this.pendingReasoning.flatMap(event => {
      const preview = typeof event.text === 'string' ? event.text
        : typeof event.preview === 'string' ? event.preview : ''
      const thinking = preview.trim()
      const visible = visibleText.trim()
      // Older Hermes versions relayed the visible reply (truncated to 500
      // chars) as reasoning.available. Only discard a source-verified match.
      if (visible && thinking && (visible === thinking
        || (thinking.length >= 490 && visible.startsWith(thinking)))) return []
      return [{ ...event, event: 'hermes.reasoning.verified',
        message_id: typeof event.message_id === 'string' && event.message_id
          ? event.message_id : this.reasoningId(),
        derived_from: event.event, text: preview }]
    })
    this.pendingReasoning = []
    this.reasoningSegment += 1
    return result
  }

  ingest(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>[] {
    const name = typeof event.event === 'string' ? event.event : event.type
    if (name === 'reasoning.delta' || name === 'thinking.delta') {
      return [{ ...event, message_id: typeof event.message_id === 'string' && event.message_id
        ? event.message_id : this.reasoningId() }]
    }
    if (name === 'reasoning.available'
      || (name === 'tool.progress' && event.tool_name === '_thinking')) {
      this.pendingReasoning.push(event)
      // Keep the original event for diagnostics; verify the preview before
      // projecting it, because old Hermes builds mislabeled plain replies.
      return [{ ...event, agentLensDeferred: true }]
    }
    if (name === 'message.started') {
      const message = event.message && typeof event.message === 'object'
        ? event.message as Record<string, unknown> : {}
      if (message.role === 'assistant') {
        this.activeId = typeof message.id === 'string' && message.id
          ? message.id : this.messageId()
        return [{ ...event, message_id: this.activeId }]
      }
      return [event]
    }

    if (name === 'message.delta' || name === 'assistant.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) return [event]
      const id = typeof event.message_id === 'string' && event.message_id
        ? event.message_id : this.messageId()
      this.activeId = id
      this.segmentText += delta
      return [{ ...event, message_id: id }]
    }

    // A completed interim is visible assistant commentary, NOT reasoning.
    // If the gateway did not already stream it, provide the text once before
    // the commentary boundary. A boundary never means the run has completed.
    if (name === 'message.interim' || name === 'assistant.commentary') {
      const id = this.messageId()
      const value = typeof event.text === 'string' ? event.text
        : typeof event.content === 'string' ? event.content : ''
      const events: Readonly<Record<string, unknown>>[] = []
      if (value && value !== this.segmentText) {
        events.push({
          event: 'hermes.reply.interim-text', message_id: id, content: value,
          derived_from: name, run_id: this.runId,
        })
      }
      events.push({ ...event, message_id: id })
      const reasoning = this.releaseReasoning(value || this.segmentText)
      this.lastInterim = { id, text: value || this.segmentText }
      this.advance()
      return [...reasoning, ...events]
    }

    // Some providers send ordinary assistant deltas before a tool without
    // emitting message.interim. Preserve that text as commentary instead of
    // leaving a stray final answer before the tool.
    if (name === 'tool.started') {
      const toolEvent = this.toolEvent(event, name)
      const reasoning = this.releaseReasoning(this.segmentText)
      if (!this.segmentText) return [...reasoning, toolEvent]
      const boundary = {
        event: 'message.interim', run_id: this.runId,
        message_id: this.messageId(), already_streamed: true,
        text: this.segmentText, derived_from: 'tool.started',
      }
      this.lastInterim = { id: this.messageId(), text: this.segmentText }
      this.advance()
      return [...reasoning, boundary, toolEvent]
    }

    if (name === 'tool.completed' || name === 'tool.failed') {
      return [this.toolEvent(event, name)]
    }
    if (name === 'assistant.completed') {
      const id = typeof event.message_id === 'string' && event.message_id
        ? event.message_id : this.messageId()
      this.activeId = id
      if (typeof event.content === 'string') this.segmentText = event.content
      return [...this.releaseReasoning(this.segmentText), { ...event, message_id: id }]
    }

    if (name === 'run.completed') {
      const output = typeof event.output === 'string' ? event.output : ''
      const reasoning = this.releaseReasoning(output)
      if (!output) return [...reasoning, event]
      // Hermes may repeat the pre-tool interim as its final answer. Promote
      // the SAME message rather than appending a duplicate final bubble.
      if (!this.segmentText && this.lastInterim?.text === output) {
        return [
          ...reasoning,
          { event: 'hermes.reply.promote', message_id: this.lastInterim.id,
            run_id: this.runId, derived_from: 'run.completed' },
          event,
        ]
      }
      return [
        ...reasoning,
        { event: 'hermes.reply.final', message_id: this.messageId(),
          content: output, run_id: this.runId, derived_from: 'run.completed' },
        event,
      ]
    }
    if (name === 'run.failed' || name === 'run.interrupted' || name === 'run.cancelled') {
      return [...this.releaseReasoning(), event]
    }
    return [event]
  }
}
