/** Presentation-only interpretation of already confirmed failure facts. Never changes the recorded error. */
export interface TaskErrorDiagnostic {
  code?: string | undefined
  category?: string | undefined
  retryable?: boolean | undefined
}

export type TaskErrorKind = 'quota' | 'auth' | 'rateLimit' | 'timeout' | 'context' | 'unknown'

export interface TaskErrorPresentation {
  kind: TaskErrorKind
  statusCode?: number | undefined
  code?: string | undefined
  preview: string
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function nonempty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Extract a JSON provider envelope only when the complete suffix parses. */
function providerPayload(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{')
  if (start === -1) return {}
  try { return object(JSON.parse(raw.slice(start))) } catch { return {} }
}

export function presentTaskError(raw: string, diagnostic?: TaskErrorDiagnostic): TaskErrorPresentation {
  const payload = providerPayload(raw)
  const nested = object(payload.error)
  const statusMatch = raw.match(/^\\s*(?:HTTP\\s*)?([1-5]\\d{2})\\s*:/i)
  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined
  const originalCode = nonempty(diagnostic?.code) || nonempty(payload.code) || nonempty(nested.code)
  const code = /^\\d{3}$/.test(originalCode) ? undefined : originalCode || undefined
  const marker = (code || nonempty(diagnostic?.category)).toLowerCase()
  const message = nonempty(payload.message) || nonempty(nested.message)
    || nonempty(payload.detail) || raw.replace(/^\\s*(?:HTTP\\s*)?[1-5]\\d{2}\\s*:\\s*/i, '').trim()
  const knownCodes: Record<Exclude<TaskErrorKind, 'unknown'>, readonly string[]> = {
    quota: ['insufficient_user_quota', 'insufficient_quota', 'quota_exceeded'],
    auth: ['invalid_api_key', 'authentication_error', 'invalid_authentication'],
    rateLimit: ['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests'],
    timeout: ['timeout', 'etimedout', 'request_timeout'],
    context: ['context_length_exceeded', 'context_window_exceeded'],
  }
  let kind: TaskErrorKind = 'unknown'
  for (const [name, markers] of Object.entries(knownCodes)) {
    if (markers.includes(marker)) {
      kind = name as TaskErrorKind
      break
    }
  }
  // Provider versions may omit a code but retain their explicit stable error phrase.
  if (kind === 'unknown' && /\\buser quota is not enough\\b/i.test(message)) kind = 'quota'
  if (kind === 'unknown' && statusCode === 401) kind = 'auth'
  if (kind === 'unknown' && statusCode === 429) kind = 'rateLimit'
  const preview = message.length > 220 ? `${message.slice(0, 220).trimEnd()}…` : message
  return { kind, ...(statusCode ? { statusCode } : {}), ...(code ? { code } : {}), preview }
}
