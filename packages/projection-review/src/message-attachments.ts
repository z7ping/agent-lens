import type { JsonValue, ReviewMessageAttachmentDto } from '@agent-lens/protocol'

export interface ReviewMessageImageSource {
  type: 'image'
  data: string
  mimeType: string
  name?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function imageSource(value: unknown): ReviewMessageImageSource | null {
  const attachment = record(value)
  if (attachment.type !== 'image') return null
  const data = typeof attachment.data === 'string' ? attachment.data.trim() : ''
  const mimeType = typeof attachment.mimeType === 'string'
    ? attachment.mimeType.trim().toLowerCase()
    : ''
  if (!data || !mimeType.startsWith('image/')) return null
  const name = typeof attachment.name === 'string' ? attachment.name.trim() : ''
  return {
    type: 'image',
    data,
    mimeType,
    ...(name ? { name } : {}),
  }
}

export function reviewMessageImageSources(payload: JsonValue | unknown): ReviewMessageImageSource[] {
  const attachments = record(payload).attachments
  if (!Array.isArray(attachments)) return []
  return attachments.flatMap(value => {
    const image = imageSource(value)
    return image ? [image] : []
  })
}

export function reviewMessageAttachments(
  observationId: string,
  payload: JsonValue | unknown,
): ReviewMessageAttachmentDto[] {
  return reviewMessageImageSources(payload).map((image, index) => ({
    type: 'image',
    observationId,
    index,
    mimeType: image.mimeType,
    ...(image.name ? { name: image.name } : {}),
  }))
}

export function reviewMessageImageSourceAt(
  payload: JsonValue | unknown,
  index: number,
): ReviewMessageImageSource | null {
  if (!Number.isSafeInteger(index) || index < 0) return null
  return reviewMessageImageSources(payload)[index] ?? null
}
