import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const fallback = readFileSync(new URL('./in-process-host.ts', import.meta.url), 'utf8')

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
  assert.doesNotMatch(worker, /:\s*stopReason\s*\?\s*'completed'/)
  assert.match(worker, /stopReason === 'length'[\s\S]{0,80}Pi 输出被截断/)
  assert.match(worker, /stopReason === 'deferred'[\s\S]{0,80}Pi 响应已延迟/)
})

test('Pi Indexed 预览只处理有界文本前缀，不复制完整长输入', () => {
  const start = worker.indexOf('function boundedRoundPreview(')
  const end = worker.indexOf('\nfunction roundIndex(', start)
  assert.ok(start >= 0 && end > start)
  const preview = runInNewContext(
    worker.slice(start, end) + '\n;boundedRoundPreview',
    { record: (value: unknown) => value && typeof value === 'object' ? value : {} },
  ) as (content: unknown) => string
  assert.equal(preview('  hello  \n world  '), 'hello world')
  assert.equal(preview([{ type: 'image' }, { text: ' First \n line ' }, { text: 'second' }]), 'First line second')
  assert.equal(preview([{ type: 'image' }]), '')
  assert.equal(preview('abc'.repeat(1_000_000)), 'abc'.repeat(29).slice(0, 86))
  assert.equal(preview([{ text: '中'.repeat(100_000) }, { text: 'not used' }]).length, 86)
  assert.match(worker.slice(start, end), /raw\.slice\(0, 8192\)/)
  assert.match(fallback, /function boundedRoundPreview\(content: unknown\): string/)
  assert.match(fallback, /const preview = boundedRoundPreview\(message\.content \?\? entry\.content\)/)
  assert.doesNotMatch(fallback, /content\.map\(part => typeof part === 'string'/)
})
