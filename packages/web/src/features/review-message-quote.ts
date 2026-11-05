import type { ReviewMessageNodeDto } from '@agent-lens/protocol'
import { taskUserRequestText } from './task-detail-model'

/** Never quote an unloaded native body placeholder or assistant process prose. */
export function reviewQuoteableText(
  node: Pick<ReviewMessageNodeDto, 'role' | 'text' | 'nativeLazyText'>,
  loadedNativeText?: string,
): string {
  if (node.role === 'reasoning' || node.role === 'commentary') return ''
  if (node.nativeLazyText) return loadedNativeText ?? ''
  return node.role === 'user' ? taskUserRequestText(node.text) : node.text
}
