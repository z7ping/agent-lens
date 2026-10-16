import type { LiveInputCapabilitiesDto, LiveMessageDto } from '@agent-lens/protocol'
import { liveAttachmentPreviewUrl } from '../client/live-attachments'
import type { LiveTaskProjectionAttachment } from './live-task-projection'

/** Live 输入能力验证与乐观附件预览。 */
export function messageText(message: LiveMessageDto): string {
  return message.parts
    .flatMap(part => part.type === 'text' || part.type === 'large-text' ? [part.text] : [])
    .join('\n\n')
    .trim()
}

export function messageHasAttachments(message: LiveMessageDto): boolean {
  return message.parts.some(part => part.type === 'image' || part.type === 'file')
}

export async function optimisticMessageAttachments(
  message: LiveMessageDto,
): Promise<LiveTaskProjectionAttachment[]> {
  const attachments = message.parts.filter(
    (part): part is Extract<LiveMessageDto['parts'][number], { type: 'image' | 'file' }> =>
      part.type === 'image' || part.type === 'file',
  )
  return Promise.all(attachments.map(async part => {
    const attachment: LiveTaskProjectionAttachment = {
      type: part.type,
      ...(part.name ? { name: part.name } : {}),
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      ...(part.sizeBytes !== undefined ? { sizeBytes: part.sizeBytes } : {}),
    }
    if (part.type !== 'image') return attachment
    try {
      const response = await fetch(liveAttachmentPreviewUrl(part.attachmentId))
      if (!response.ok) return attachment
      const previewUrl = URL.createObjectURL(await response.blob())
      return { ...attachment, previewUrl }
    } catch {
      return attachment
    }
  }))
}

export function unsupportedInput(
  message: LiveMessageDto,
  capabilities: LiveInputCapabilitiesDto,
): 'largeText' | 'image' | 'file' | null {
  for (const part of message.parts) {
    if (part.type === 'large-text' && capabilities.largeText === 'unsupported') return 'largeText'
    if (part.type === 'image' && capabilities.image === 'unsupported') return 'image'
    if (part.type === 'file' && capabilities.file === 'unsupported') return 'file'
  }
  return null
}

