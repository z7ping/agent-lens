const REPEAT_WINDOW_MS = 60_000
let lastLoggedAt = 0
let suppressed = 0

function verboseDiagnostics(): boolean {
  return process.env.NODE_ENV === 'development'
    || Boolean(process.env.AGENT_LENS_DEV_API_PORT)
    || process.env.AGENT_LENS_LOG_LEVEL === 'debug'
}

export function logSessionSummaryRefreshFailure(error: unknown): void {
  if (verboseDiagnostics()) {
    console.error('[AgentLens] session summary projection refresh failed', error)
    return
  }

  const now = Date.now()
  if (lastLoggedAt && now - lastLoggedAt < REPEAT_WINDOW_MS) {
    suppressed += 1
    return
  }
  console.error('[AgentLens] session summary projection refresh failed', error, {
    ...(suppressed ? { suppressedSinceLastLog: suppressed } : {}),
  })
  lastLoggedAt = now
  suppressed = 0
}
