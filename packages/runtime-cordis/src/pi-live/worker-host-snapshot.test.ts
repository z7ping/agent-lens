import assert from 'node:assert/strict'
import test from 'node:test'
import { serialize } from 'node:v8'
import type { PiLiveSnapshot } from './types'
import { piLiveWorkerHostInternals } from './worker-host'

function snapshot(): PiLiveSnapshot {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    type: 'message',
    id: `entry-${index}`,
    message: { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `${index}:${'x'.repeat(120_000)}` }] },
  }))
  return {
    state: {
      runtimeSessionId: 'runtime-1',
      status: 'ready',
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId: 'entry-11',
    },
    entries,
    leafId: 'entry-11',
  }
}

test('Pi Live Worker snapshot 超过 1 MiB 时通过多块重组且保持完整历史', async () => {
  const expected = snapshot()
  const bytes = serialize(expected)
  assert.ok(bytes.byteLength > 1024 * 1024)

  const transferId = 'snapshot-transfer-1'
  const chunkBytes = 192 * 1024
  let offset = 0
  let sequence = 0
  const commands: string[] = []

  const actual = await piLiveWorkerHostInternals.collectSnapshotTransfer(async (command, payload) => {
    commands.push(command)
    if (command === 'snapshotBegin') {
      assert.deepEqual(payload, { since: 'entry-before' })
    } else {
      assert.deepEqual(payload, { transferId })
    }
    const start = offset
    const end = Math.min(bytes.length, start + chunkBytes)
    offset = end
    const currentSequence = sequence
    sequence += 1
    return {
      transferId,
      sequence: currentSequence,
      chunk: bytes.subarray(start, end),
      done: end >= bytes.length,
    }
  }, 'entry-before')

  assert.deepEqual(actual, expected)
  assert.ok(commands.length > 2)
  assert.equal(commands[0], 'snapshotBegin')
  assert.ok(commands.slice(1).every(command => command === 'snapshotChunk'))
})

test('Pi Live Worker snapshot 分块乱序时拒绝静默拼接', async () => {
  await assert.rejects(
    piLiveWorkerHostInternals.collectSnapshotTransfer(async command => ({
      transferId: 'snapshot-transfer-1',
      sequence: command === 'snapshotBegin' ? 0 : 2,
      chunk: Buffer.from('x'),
      done: command !== 'snapshotBegin',
    })),
    /out of order/,
  )
})
