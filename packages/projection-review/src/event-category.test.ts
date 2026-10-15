import assert from 'node:assert/strict'
import test from 'node:test'
import { eventCategory } from './nodes'

test('Pi 原生思考级别调整归入模型事件而非未知事件', () => {
  assert.equal(eventCategory('thinking.level.changed'), 'model')
  assert.equal(eventCategory('model.changed'), 'model')
  assert.equal(eventCategory('session.lifecycle'), 'lifecycle')
})
