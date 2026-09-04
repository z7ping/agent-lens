function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Match Pi's official JSON/RPC wire semantics for AgentSession events.
 * In particular, message_update must not carry the cumulative `partial` assistant
 * snapshot on every delta; message_start + deltas + message_end are sufficient.
 */
export function toPiLiveWireEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== 'message_update') return event

  const message = record(event.message)
  if (message.role !== 'assistant') {
    throw new Error('Pi SDK message_update message is not an assistant message')
  }

  const assistantEvent = record(event.assistantMessageEvent)
  const { partial, ...deltaEvent } = assistantEvent

  if (assistantEvent.type === 'toolcall_start') {
    const partialMessage = record(partial)
    const content = Array.isArray(partialMessage.content) ? partialMessage.content : []
    const contentIndex = typeof assistantEvent.contentIndex === 'number'
      ? assistantEvent.contentIndex
      : -1
    const toolCall = contentIndex >= 0 ? record(content[contentIndex]) : {}
    if (toolCall.type !== 'toolCall') {
      throw new Error(`Pi SDK toolcall_start content at index ${contentIndex} is not a tool call`)
    }
    return {
      type: 'message_update',
      usage: message.usage,
      assistantMessageEvent: {
        ...deltaEvent,
        id: toolCall.id,
        toolName: toolCall.name,
      },
    }
  }

  return {
    type: 'message_update',
    usage: message.usage,
    assistantMessageEvent: deltaEvent,
  }
}
