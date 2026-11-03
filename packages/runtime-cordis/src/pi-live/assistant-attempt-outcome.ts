/** An assistant message can fail without terminating the enclosing Pi logical run. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function piErrorText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const nested = record(value)
  return text(nested.message).trim() || text(nested.errorMessage).trim()
    || text(nested.detail).trim() || text(nested.description).trim()
}

export function piEventErrorText(...values: unknown[]): string {
  for (const value of values) {
    const message = piErrorText(value)
    if (message) return message
  }
  return ''
}

/** Only native assistant completion facts classify an attempt; no text heuristics. */
export function piAssistantAttemptFailed(
  message: Record<string, unknown>,
  event: Record<string, unknown>,
): boolean {
  return message.stopReason === 'error'
    || Boolean(piEventErrorText(message.errorMessage, message.error, event.errorMessage, event.error))
}
