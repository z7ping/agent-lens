import type {
  LiveInputCapabilities,
  LiveInputSupport,
  LiveMessage,
  LiveMessageInput,
  LiveMessagePart,
} from '@agent-lens/core'

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`Live message ${field} must be a string`)
  return value
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Live message ${field} must be a non-negative integer`)
  }
  return value
}

function normalizePart(value: unknown): LiveMessagePart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Live message part must be an object')
  }
  const part = value as Record<string, unknown>
  if (part.type === 'text') {
    if (typeof part.text !== 'string') throw new TypeError('Live text part requires text')
    return { type: 'text', text: part.text }
  }
  if (part.type === 'large-text') {
    if (typeof part.text !== 'string') throw new TypeError('Live large-text part requires text')
    const lineCount = optionalCount(part.lineCount, 'lineCount')
    const charCount = optionalCount(part.charCount, 'charCount')
    return {
      type: 'large-text',
      text: part.text,
      ...(lineCount !== undefined ? { lineCount } : {}),
      ...(charCount !== undefined ? { charCount } : {}),
    }
  }
  if (part.type === 'image' || part.type === 'file') {
    if (typeof part.attachmentId !== 'string' || !part.attachmentId.trim()) {
      throw new TypeError(`Live ${part.type} part requires attachmentId`)
    }
    const name = optionalText(part.name, 'name')
    const mimeType = optionalText(part.mimeType, 'mimeType')
    const sizeBytes = optionalCount(part.sizeBytes, 'sizeBytes')
    return {
      type: part.type,
      attachmentId: part.attachmentId,
      ...(name !== undefined ? { name } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }
  }
  throw new TypeError(`Unsupported Live message part type: ${String(part.type)}`)
}

export function normalizeLiveMessage(input: LiveMessageInput): LiveMessage {
  if (typeof input === 'string') {
    return { parts: [{ type: 'text', text: input }] }
  }
  if (!input || typeof input !== 'object' || !Array.isArray(input.parts)) {
    throw new TypeError('Live message requires parts')
  }
  return { parts: input.parts.map(normalizePart) }
}

export function liveInputSupportForPart(
  capabilities: Readonly<LiveInputCapabilities>,
  part: LiveMessagePart,
): LiveInputSupport {
  if (part.type === 'text') return capabilities.text
  if (part.type === 'large-text') return capabilities.largeText
  if (part.type === 'image') return capabilities.image
  return capabilities.file
}

export function requireLiveMessageSupport(
  message: LiveMessage,
  capabilities: Readonly<LiveInputCapabilities>,
  liveId = 'live adapter',
): void {
  for (const part of message.parts) {
    if (liveInputSupportForPart(capabilities, part) === 'unsupported') {
      throw new Error(`${liveId} does not support Live input part: ${part.type}`)
    }
  }
}

export function liveMessageToPlainText(
  message: LiveMessage,
  capabilities: Readonly<LiveInputCapabilities>,
  liveId = 'live adapter',
): string {
  requireLiveMessageSupport(message, capabilities, liveId)

  const blocks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'large-text') {
      blocks.push(part.text)
      continue
    }
    throw new Error(
      `${liveId} must transform Live input part before plain-text dispatch: ${part.type}`,
    )
  }
  return blocks.join('\n\n')
}
