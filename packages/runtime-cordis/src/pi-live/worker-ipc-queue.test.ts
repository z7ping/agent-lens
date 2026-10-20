import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')

function transport() {
  const functions = ['record', 'isCoalescibleEnvelope', 'mergeCoalescibleEnvelope', 'flushOutbound', 'enqueueEnvelope']
    .map(name => {
      const source = worker.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]
      if (!source) throw new Error(`缺少 Worker 函数：${name}`)
      return source
    }).join('\n')
  const sent: unknown[] = []
  const callbacks: Array<(error?: Error) => void> = []
  const failures: Error[] = []
  const result = runInNewContext(`
    const MAX_MESSAGE_BYTES = 1024 * 1024;
    const outboundQueue = [];
    let outboundSending = false;
    let exitAfterFlush = false;
    ${functions}
    ({ enqueueEnvelope, size: () => outboundQueue.length });
  `, {
    Buffer,
    process: { connected: true, send: (value: unknown, callback: (error?: Error) => void) => {
      sent.push(value)
      callbacks.push(callback)
    } },
    failTransport: (error: Error) => failures.push(error),
  }) as { enqueueEnvelope(value: unknown): boolean; size(): number }
  return { ...result, sent, failures, drain: () => { while (callbacks.length) callbacks.shift()!() } }
}

function delta(type: string, value: string, contentIndex = 0) {
  return { type: 'event', payload: { type: 'message_update', assistantMessageEvent: { type, contentIndex, delta: value } } }
}

test('工具参数突发时合并增量，保留完整参数和终止事件', () => {
  const queue = transport()
  queue.enqueueEnvelope({ type: 'event', payload: { type: 'message_start' } })
  for (let index = 0; index < 2_000; index++) queue.enqueueEnvelope(delta('toolcall_delta', `${index},`))
  queue.enqueueEnvelope({ type: 'event', payload: { type: 'message_end' } })
  assert.equal(queue.failures.length, 0)
  assert.equal(queue.size(), 2)
  queue.drain()
  const sent = queue.sent as Array<{ payload: { type: string; assistantMessageEvent?: { delta: string } } }>
  assert.equal(sent.length, 3)
  assert.equal(sent[1].payload.assistantMessageEvent?.delta, Array.from({ length: 2_000 }, (_, index) => `${index},`).join(''))
  assert.equal(sent[2].payload.type, 'message_end')
})

test('超过原 256 条阈值的不可合并事件完整排队发送，不丢弃增量或退出 Worker', () => {
  const queue = transport()
  queue.enqueueEnvelope({ type: 'response', requestId: '正在发送' })
  for (let index = 0; index < 2_000; index++) {
    queue.enqueueEnvelope(delta('toolcall_delta', `参数${index}`, index))
    queue.enqueueEnvelope({ type: 'event', payload: { type: 'tool_execution_end', index } })
  }
  assert.equal(queue.size(), 4_000)
  assert.equal(queue.failures.length, 0)
  queue.drain()
  assert.equal(queue.sent.length, 4_001)
  for (let index = 0; index < 2_000; index++) {
    assert.deepEqual(queue.sent[1 + index * 2], delta('toolcall_delta', `参数${index}`, index))
    assert.deepEqual(queue.sent[2 + index * 2], { type: 'event', payload: { type: 'tool_execution_end', index } })
  }
})

test('增量合并不跨内容块、增量类型或生命周期边界', () => {
  const queue = transport()
  queue.enqueueEnvelope(delta('text_delta', '正文'))
  queue.enqueueEnvelope(delta('thinking_delta', '思考'))
  queue.enqueueEnvelope(delta('toolcall_delta', '参数甲', 0))
  queue.enqueueEnvelope(delta('toolcall_delta', '参数乙', 1))
  queue.enqueueEnvelope({ type: 'event', payload: { type: 'message_end' } })
  queue.enqueueEnvelope(delta('toolcall_delta', '下一条消息', 1))
  queue.drain()
  assert.equal(queue.sent.length, 6)
  assert.equal(queue.failures.length, 0)
})

test('大块中文参数合并仍受单条消息字节上限约束', () => {
  const queue = transport()
  queue.enqueueEnvelope({ type: 'response' })
  const chunk = '参'.repeat(100_000)
  queue.enqueueEnvelope(delta('toolcall_delta', chunk))
  queue.enqueueEnvelope(delta('toolcall_delta', chunk))
  assert.equal(queue.size(), 2)
  queue.drain()
  assert.equal(queue.sent.length, 3)
  assert.equal(queue.failures.length, 0)
})
