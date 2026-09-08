const PRODUCTION_REPEAT_WINDOW_MS = 60_000

interface RepeatedDiagnostic {
  lastLoggedAt: number
  suppressed: number
}

const repeatedDiagnostics = new Map<string, RepeatedDiagnostic>()

function verboseDiagnostics(): boolean {
  return process.env.NODE_ENV === 'development'
    || Boolean(process.env.AGENT_LENS_DEV_API_PORT)
    || process.env.AGENT_LENS_LOG_LEVEL === 'debug'
}

export function logDataRuntimeDebug(message: string, details: Record<string, unknown>): void {
  if (verboseDiagnostics()) console.warn(message, details)
}

export function logDataRuntimeFailure(
  message: string,
  details: Record<string, unknown>,
  key = message,
): void {
  if (verboseDiagnostics()) {
    console.warn(message, details)
    return
  }

  const now = Date.now()
  const previous = repeatedDiagnostics.get(key)
  if (previous && now - previous.lastLoggedAt < PRODUCTION_REPEAT_WINDOW_MS) {
    previous.suppressed += 1
    return
  }

  console.warn(message, {
    ...details,
    ...(previous?.suppressed ? { suppressedSinceLastLog: previous.suppressed } : {}),
  })
  repeatedDiagnostics.set(key, { lastLoggedAt: now, suppressed: 0 })
}

export const dataRuntimeDiagnosticInternals = {
  PRODUCTION_REPEAT_WINDOW_MS,
  repeatedDiagnostics,
  reset() { repeatedDiagnostics.clear() },
}
