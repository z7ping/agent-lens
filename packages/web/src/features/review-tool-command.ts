function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

export function reviewToolCommand(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const input = recordValue(value)
  const direct = stringValue(input, 'command', 'cmd', 'script', 'raw')
  if (direct) return direct

  const parsed = input.parsedCommand ?? input.parsed_command
  if (Array.isArray(parsed)) {
    const commands = parsed
      .map(item => stringValue(recordValue(item), 'cmd', 'command'))
      .filter(Boolean)
    if (commands.length) return commands.join('\n')
  }

  if (Array.isArray(input.command)) {
    const command = input.command.filter((item): item is string => typeof item === 'string')
    const shellFlag = command.findIndex(item => item === '-Command' || item === '-c')
    if (shellFlag >= 0 && command[shellFlag + 1]) return command.slice(shellFlag + 1).join(' ')
    return command.join(' ')
  }
  return ''
}
