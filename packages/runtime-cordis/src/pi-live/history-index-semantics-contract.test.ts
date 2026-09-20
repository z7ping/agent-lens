import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')

test('Pi Indexed Process 只统计 Assistant 执行块与 Tool，不把普通元事件算进去', () => {
  assert.match(worker, /const processMessages = blocks\.filter\(block =>[\s\S]*?block\.type === 'thinking'[\s\S]*?index !== finalAssistantIndex && block\.type === 'text'/)
  assert.match(worker, /const toolBlocks = blocks\.filter\(block => block\.type === 'toolCall'\)/)
  assert.doesNotMatch(worker, /itemCount \+= 1[\s\S]{0,120}entry\.type === 'model_change'/)
})

test('Pi Final entry 中的 thinking 保留在 Process，最终 text 才排除', () => {
  assert.match(worker, /block\.type === 'thinking' \|\| \(index !== finalAssistantIndex && block\.type === 'text'\)/)
})

test('Pi Indexed 关键事件有界且记录 Final 前后位置', () => {
  assert.match(worker, /LIVE_HISTORY_META_EVENT_LIMIT = 24/)
  assert.match(worker, /finalAssistantIndex >= 0 && index >= finalAssistantIndex \? 'after-final' : 'before-final'/)
  assert.match(worker, /eventOmittedCount/)
})
