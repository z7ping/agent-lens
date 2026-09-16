export function reviewMessageAttachmentUrl(observationId: string, index: number): string {
  return `/api/v1/review-attachments/${encodeURIComponent(observationId)}/${index}`
}
