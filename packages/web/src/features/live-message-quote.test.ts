import assert from 'node:assert/strict'
import test from 'node:test'
import { liveMessageQuote } from './live-message-quote'

test('Quote a selected part as Markdown without sending or destroying draft', () => {
  assert.equal(liveMessageQuote(' first line\nsecond line '), '> first line\n> second line\n\n')
  assert.equal(liveMessageQuote('\r\n'), '')
  assert.equal(liveMessageQuote('a\r\nb'), '> a\n> b\n\n')
})
test('Quote long native answers with an explicit boundary and never include the whole file', () => {
  assert.equal(liveMessageQuote('a'.repeat(8), 5), '> aaaaa\n> …\n\n')
  assert.equal(liveMessageQuote('abc', -1), '')
  assert.equal(liveMessageQuote('a\nb', 100), '> a\n> b\n\n')
})
