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

  constructor(private readonly runId: string) {}

  private messageId(): string {
    return this.activeId ??= `hermes:${this.runId}:segment:${this.segment}`
  }

  private advance(): void {
    this.segment += 1
    this.activeId = undefined
    this.segmentText = ''
  }

  ingest(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>[] {
    const name = typeof event.event === 'string' ? event.event : event.type
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
      this.lastInterim = { id, text: value || this.segmentText }
      this.advance()
      return events
    }

    // Some providers send ordinary assistant deltas before a tool without
    // emitting message.interim. Preserve that text as commentary instead of
    // leaving a stray final answer before the tool.
    if (name === 'tool.started' && this.segmentText) {
      const boundary = {
        event: 'message.interim', run_id: this.runId,
        message_id: this.messageId(), already_streamed: true,
        text: this.segmentText, derived_from: 'tool.started',
      }
      this.lastInterim = { id: this.messageId(), text: this.segmentText }
      this.advance()
      return [boundary, event]
    }

    if (name === 'assistant.completed') {
      const id = typeof event.message_id === 'string' && event.message_id
        ? event.message_id : this.messageId()
      this.activeId = id
      if (typeof event.content === 'string') this.segmentText = event.content
      return [{ ...event, message_id: id }]
    }

    if (name === 'run.completed') {
      const output = typeof event.output === 'string' ? event.output : ''
      if (!output) return [event]
      // Hermes may repeat the pre-tool interim as its final answer. Promote
      // the SAME message rather than appending a duplicate final bubble.
      if (!this.segmentText && this.lastInterim?.text === output) {
        return [
          { event: 'hermes.reply.promote', message_id: this.lastInterim.id,
            run_id: this.runId, derived_from: 'run.completed' },
          event,
        ]
      }
      return [
        { event: 'hermes.reply.final', message_id: this.messageId(),
          content: output, run_id: this.runId, derived_from: 'run.completed' },
        event,
      ]
    }
    return [event]
  }
}
