import assert from 'node:assert/strict'
import test from 'node:test'
import { shareInFlight } from './single-flight'

test('single-flight shares an exact key but never merges different keys', async () => {
  const inFlight = new Map<string, Promise<unknown>>()
  let starts = 0
  const start = async (value: string) => {
    starts += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return value
  }

  const same = Array.from({ length: 100 }, () =>
    shareInFlight(inFlight, 'same', () => start('same')),
  )
  const other = shareInFlight(inFlight, 'other', () => start('other'))

  assert.deepEqual(await Promise.all(same), Array.from({ length: 100 }, () => 'same'))
  assert.equal(await other, 'other')
  assert.equal(starts, 2)
})

test('single-flight releases a failed key so the next request can retry', async () => {
  const inFlight = new Map<string, Promise<unknown>>()
  let starts = 0

  const first = shareInFlight(inFlight, 'retry', async () => {
    starts += 1
    throw new Error('temporary failure')
  })
  await assert.rejects(first, /temporary failure/)

  const second = await shareInFlight(inFlight, 'retry', async () => {
    starts += 1
    return 'ok'
  })

  assert.equal(second, 'ok')
  assert.equal(starts, 2)
})
