import type { LiveErrorEvent } from '@agent-lens/core'

export function formatLiveError(
  error: unknown,
  maxLength = 2_000,
): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, Math.max(0, maxLength))
}

/**
 * Read only native error facts. No HTTP status, provider name or localized
 * message heuristics; unknown categories are intentionally not interpreted.
 */
export function normalizeNativeLiveError(value: unknown, fallback: string): LiveErrorEvent {
  const seen = new Set<object>()
  let message = ''
  let code: string | undefined
  let category: LiveErrorEvent['category']
  let retryable: boolean | undefined
  const categories: readonly LiveErrorEvent['category'][] = [
    'provider', 'network', 'runtime', 'tool', 'permission', 'unknown',
  ]

  const visit = (input: unknown, depth = 0): void => {
    if (depth > 5 || input == null) return
    if (typeof input === 'string') {
      if (!message && input.trim()) message = input.trim()
      return
    }
    if (typeof input !== 'object' || seen.has(input)) return
    seen.add(input)
    if (Array.isArray(input)) {
      for (const item of input.slice(0, 10)) visit(item, depth + 1)
      return
    }
    const fields = input as Record<string, unknown>
    const nativeMessage = fields.message ?? fields.errorMessage
    if (!message && typeof nativeMessage === 'string' && nativeMessage.trim()) {
      message = nativeMessage.trim()
    }
    if (!code && (typeof fields.code === 'string' || typeof fields.code === 'number')) {
      code = String(fields.code).trim() || undefined
    }
    if (!category && categories.includes(fields.category as LiveErrorEvent['category'])) {
      category = fields.category as LiveErrorEvent['category']
    }
    if (retryable === undefined && typeof fields.retryable === 'boolean') {
      retryable = fields.retryable
    }
    visit(fields.error, depth + 1)
    visit(fields.cause, depth + 1)
    visit(fields.errors, depth + 1)
  }
  visit(value)
  return {
    type: 'error',
    message: formatLiveError(message || code || fallback),
    ...(code ? { code } : {}),
    ...(category ? { category } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  }
}
