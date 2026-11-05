/** Reuse the existing Lexical restoreMessage flow. Never submit the quote. */
export function liveMessageQuote(value: string, maxLength = 2_000): string {
  const source = value.replace(/\r\n?/g, '\n').trim()
  if (!source || !Number.isSafeInteger(maxLength) || maxLength < 1) return ''
  const truncated = source.length > maxLength
  const content = truncated ? source.slice(0, maxLength).trimEnd() : source
  const quote = content.split('\n').map(line => line ? `> ${line}` : '>').join('\n')
  return quote + (truncated ? '\n> …' : '') + '\n\n'
}
