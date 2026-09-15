export interface LiveTextPartDto {
  type: 'text'
  text: string
}

export interface LiveLargeTextPartDto {
  type: 'large-text'
  text: string
  lineCount?: number | undefined
  charCount?: number | undefined
}

export interface LiveAttachmentDescriptorDto {
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes: number
}

export interface LiveAttachmentPartDto {
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes?: number | undefined
}

export interface LiveImagePartDto extends LiveAttachmentPartDto {
  type: 'image'
}

export interface LiveFilePartDto extends LiveAttachmentPartDto {
  type: 'file'
}

export type LiveMessagePartDto =
  | LiveTextPartDto
  | LiveLargeTextPartDto
  | LiveImagePartDto
  | LiveFilePartDto

export interface LiveMessageDto {
  parts: LiveMessagePartDto[]
}

export type LiveMessageInputDto = string | LiveMessageDto

export interface LiveControlDisplayInfoDto {
  label?: string | undefined
  description?: string | undefined
}

export interface LiveControlOptionDto extends LiveControlDisplayInfoDto {
  /** Runtime-owned opaque value; surfaces must round-trip it unchanged. */
  value: string
}

export interface LiveThinkingControlDto extends LiveControlDisplayInfoDto {
  capability: 'thinking-control'
  value: string
  options: LiveControlOptionDto[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function parseLiveMessagePartDto(value: unknown): LiveMessagePartDto {
  const part = record(value)
  if (!part || typeof part.type !== 'string') {
    throw new TypeError('Live message part must be an object with type')
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string') throw new TypeError('Live text part requires text')
    return { type: 'text', text: part.text }
  }
  if (part.type === 'large-text') {
    if (typeof part.text !== 'string') throw new TypeError('Live large-text part requires text')
    const lineCount = optionalCount(part.lineCount)
    const charCount = optionalCount(part.charCount)
    if (lineCount === null) throw new TypeError('Live large-text lineCount must be a non-negative integer')
    if (charCount === null) throw new TypeError('Live large-text charCount must be a non-negative integer')
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
    const name = optionalText(part.name)
    const mimeType = optionalText(part.mimeType)
    const sizeBytes = optionalCount(part.sizeBytes)
    if (name === null) throw new TypeError(`Live ${part.type} name must be a string`)
    if (mimeType === null) throw new TypeError(`Live ${part.type} mimeType must be a string`)
    if (sizeBytes === null) throw new TypeError(`Live ${part.type} sizeBytes must be a non-negative integer`)
    return {
      type: part.type,
      attachmentId: part.attachmentId,
      ...(name !== undefined ? { name } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }
  }
  throw new TypeError(`Unsupported Live message part type: ${part.type}`)
}

export function parseLiveMessageInputDto(value: unknown): LiveMessageDto {
  if (typeof value === 'string') {
    return { parts: [{ type: 'text', text: value }] }
  }
  const message = record(value)
  if (!message || !Array.isArray(message.parts)) {
    throw new TypeError('Live message must be a string or an object with parts')
  }
  return { parts: message.parts.map(parseLiveMessagePartDto) }
}

export function liveMessagePlainTextDto(message: LiveMessageDto): string {
  const blocks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'large-text') {
      blocks.push(part.text)
      continue
    }
    throw new TypeError(`Live attachment part requires adapter transformation: ${part.type}`)
  }
  return blocks.join('\n\n')
}

export function parseLiveThinkingControlDto(value: unknown): LiveThinkingControlDto | null {
  const control = record(value)
  if (!control || control.capability !== 'thinking-control') return null
  if (typeof control.value !== 'string' || !control.value) return null
  if (!Array.isArray(control.options) || control.options.length === 0) return null

  const label = optionalText(control.label)
  const description = optionalText(control.description)
  if (label === null || description === null) return null

  const options: LiveControlOptionDto[] = []
  let hasCurrent = false
  for (const candidate of control.options) {
    const option = record(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return null
    const optionLabel = optionalText(option.label)
    const optionDescription = optionalText(option.description)
    if (optionLabel === null || optionDescription === null) return null
    if (option.value === control.value) hasCurrent = true
    options.push({
      value: option.value,
      ...(optionLabel !== undefined ? { label: optionLabel } : {}),
      ...(optionDescription !== undefined ? { description: optionDescription } : {}),
    })
  }
  if (!hasCurrent) return null

  return {
    capability: 'thinking-control',
    value: control.value,
    options,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}
