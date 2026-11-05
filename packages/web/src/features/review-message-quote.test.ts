import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewMessageNodeDto } from '@agent-lens/protocol'
import { reviewQuoteableText } from './review-message-quote'

type Minimal = Pick<ReviewMessageNodeDto, 'role' | 'text' | 'nativeLazyText'>
test('Review quotes only a loaded original native body, not its localized placeholder', () => {
  const lazy: Minimal = { role: 'assistant', text: '', nativeLazyText: {
    cursor: 'source-owned', recordSha256: '0'.repeat(64), totalTextFragments: 3,
  } }
  assert.equal(reviewQuoteableText(lazy), '')
  assert.equal(reviewQuoteableText(lazy, 'Verified fragment from original'), 'Verified fragment from original')
})
test('Review message quotes preserve real user/assistant text and exclude process blocks', () => {
  assert.equal(reviewQuoteableText({role:'assistant',text:'Actual answer'}), 'Actual answer')
  assert.equal(reviewQuoteableText({role:'reasoning',text:'hidden thoughts'}), '')
  assert.equal(reviewQuoteableText({role:'commentary',text:'process update'}), '')
})
