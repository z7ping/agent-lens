import type { LiveAttachmentDescriptorDto } from '@agent-lens/protocol'

const LIVE_ATTACHMENTS_PATH = '/api/v1/live/attachments'

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown }
    if (typeof body.message === 'string' && body.message.trim()) return body.message
  } catch {
    // Keep status fallback for non-JSON responses.
  }
  return `Live attachment request failed (status ${response.status})`
}

export async function uploadLiveAttachment(file: File, attachmentId: string): Promise<LiveAttachmentDescriptorDto> {
  const headers: Record<string, string> = {
    'content-type': file.type || 'application/octet-stream',
    'x-agentlens-attachment-id': attachmentId,
  }
  if (file.name) headers['x-agentlens-file-name'] = encodeURIComponent(file.name)

  const response = await fetch(LIVE_ATTACHMENTS_PATH, {
    method: 'POST',
    headers,
    body: file,
  })
  if (!response.ok) throw new Error(await responseMessage(response))
  return await response.json() as LiveAttachmentDescriptorDto
}

export async function removeLiveAttachment(attachmentId: string): Promise<void> {
  const response = await fetch(`${LIVE_ATTACHMENTS_PATH}/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(await responseMessage(response))
  }
}

export function liveAttachmentPreviewUrl(attachmentId: string): string {
  return `${LIVE_ATTACHMENTS_PATH}/${encodeURIComponent(attachmentId)}`
}
