import assert from 'node:assert/strict'
import test from 'node:test'
import { taskTurnRailAnswerPreview } from './task-turn-rail-answer-preview'

test('existing native prompt preview is preserved for unloaded or unanswered rounds', () => {
  assert.equal(taskTurnRailAnswerPreview('  build project  ', undefined, { question: 'Q', answer: 'A' }), 'build project')
  assert.equal(taskTurnRailAnswerPreview('', '', { question: 'Q', answer: 'A' }), '')
})
test('only real loaded answer text enters the compact existing rail tooltip', () => {
  assert.equal(taskTurnRailAnswerPreview('How?', 'Use this.', { question: 'Q', answer: 'A' }), 'Q: How? · A: Use this.')
  const text = taskTurnRailAnswerPreview('Question '.repeat(100), 'Response '.repeat(100), { question: 'Q', answer: 'A' })
  assert.ok(text.length <= 86)
  assert.match(text, /^Q: /)
  assert.match(text, / · A: /)
  assert.doesNotMatch(text, /\n/)
})
