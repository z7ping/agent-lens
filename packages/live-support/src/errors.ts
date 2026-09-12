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
