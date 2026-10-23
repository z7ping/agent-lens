import type { LiveCommandDto, LiveInputCapabilitiesDto, LiveMessageDto } from '@agent-lens/protocol'
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

/** Keep the same decoded source when the optimistic message becomes native history. */
function imageDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Live image preview could not be read'))
    reader.onerror = () => reject(reader.error ?? new Error('Live image preview could not be read'))
    reader.readAsDataURL(blob)
  })
}

async function warmImagePreview(dataUrl: string): Promise<void> {
  const image = new Image()
  image.src = dataUrl
  // Replacing the editor with the outgoing message must not first show an
  // undecoded image. A corrupt preview must not block sending to the Runtime.
  if (typeof image.decode === 'function') await image.decode().catch(() => undefined)
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
      const dataUrl = await imageDataUrl(await response.blob())
      await warmImagePreview(dataUrl)
      return { ...attachment, dataUrl }
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


/** A TUI-only command must never silently become an LLM prompt in Web Live. */
const TUI_ONLY_COMMANDS = new Set([
  '/new', '/resume', '/model', '/compact', '/settings', '/tree', '/fork',
  '/session', '/export', '/copy', '/reload', '/name', '/login', '/logout',
  '/scoped-models', '/share', '/quit', '/hotkeys',
])

export type LiveSlashResolution =
  | { kind: 'action'; command: LiveCommandDto }
  | { kind: 'blocked'; name: string }
  | { kind: 'prompt' }

/** Commands are matched against runtime-discovered actions, never against Agent ids. */
export function resolveLiveSlash(message: LiveMessageDto, commands: readonly LiveCommandDto[]): LiveSlashResolution {
  const text = messageText(message)
  const name = text.split(/\s+/)[0] ?? ''
  if (!name.startsWith('/')) return { kind: 'prompt' }
  const nativePrompt = commands.find(item => item.value === name && !item.action)
  if (nativePrompt) return { kind: 'prompt' }
  const command = commands.find(item => item.value === name && item.action)
  if (command) {
    return text === name && message.parts.every(part => part.type === 'text')
      ? { kind: 'action', command }
      : { kind: 'blocked', name }
  }
  if (TUI_ONLY_COMMANDS.has(name)) return { kind: 'blocked', name }
  return { kind: 'prompt' }
}
