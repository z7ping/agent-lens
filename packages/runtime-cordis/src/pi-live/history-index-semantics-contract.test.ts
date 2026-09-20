import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')

test('Pi Indexed Process 只统计 Thinking 与 Tool，不把普通 Assistant Text 算进去', () => {
  assert.match(worker, /const processMessages = blocks\.filter\(block => block\.type === 'thinking'\)\.length/)
  assert.match(worker, /const toolBlocks = blocks\.filter\(block => block\.type === 'toolCall'\)/)
  assert.doesNotMatch(worker, /processMessages[\s\S]{0,160}block\.type === 'text'/)
  assert.doesNotMatch(worker, /itemCount \+= 1[\s\S]{0,120}entry\.type === 'model_change'/)
})

test('Pi Indexed 最终文本按最后一个有正文的 Assistant 识别，不因同 entry 带 Tool 排除', () => {
  assert.match(worker, /const text = messageText\(message\)[\s\S]{0,80}if \(text\) \{[\s\S]{0,80}finalAssistantIndex = index/)
  assert.doesNotMatch(worker, /!hasToolCall && text/)
})

test('Pi Indexed 关键事件有界且记录 Final 前后位置', () => {
  assert.match(worker, /LIVE_HISTORY_META_EVENT_LIMIT = 24/)
  assert.match(worker, /finalAssistantIndex >= 0 && index >= finalAssistantIndex \? 'after-final' : 'before-final'/)
  assert.match(worker, /eventOmittedCount/)
})


test('Pi Indexed 只有真正 stop 才标记 completed，toolUse/length/deferred 不冒充完成', () => {
  assert.match(worker, /stopReason === 'stop'[\s\S]{0,80}\? 'completed'/)
  assert.doesNotMatch(worker, /: stopReason[\s\S]{0,40}\? 'completed'/)
  assert.match(worker, /stopReason === 'length'[\s\S]{0,80}Pi 输出被截断/)
  assert.match(worker, /stopReason === 'deferred'[\s\S]{0,80}Pi 响应已延迟/)
})
