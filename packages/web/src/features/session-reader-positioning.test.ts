import assert from 'node:assert/strict'
import test from 'node:test'
import { scrollReaderToLastUserTurn, settleReaderAtLatest } from './session-reader-positioning'

test('entry settles at the tail and cancels as soon as the reader interacts', () => {
  const previous = (globalThis as { window?: unknown }).window
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  ;(globalThis as { window?: unknown }).window = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++nextId
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id: number) { frames.delete(id) },
  }
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const pane = {
    scrollTop: 0,
    scrollHeight: 1400,
    clientHeight: 300,
    addEventListener(event: string, listener: EventListenerOrEventListenerObject) {
      const values = listeners.get(event) ?? new Set()
      values.add(listener)
      listeners.set(event, values)
    },
    removeEventListener(event: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(event)?.delete(listener)
    },
  } as unknown as HTMLElement
  const step = () => {
    const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!next) return false
    frames.delete(next[0])
    next[1](0)
    return true
  }
  try {
    const stop = settleReaderAtLatest(() => pane, () => true)
    step()
    assert.equal(pane.scrollTop, 1100)
    pane.scrollHeight = 1800
    step()
    assert.equal(pane.scrollTop, 1500)
    for (const listener of listeners.get('wheel') ?? []) {
      if (typeof listener === 'function') listener(new Event('wheel'))
    }
    pane.scrollHeight = 2400
    step()
    assert.equal(pane.scrollTop, 1500, 'manual intent must stop scheduled scrolling')
    assert.equal(frames.size, 0)
    stop()
    assert.equal(listeners.get('wheel')?.size, 0)
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
})

test('session-generation guard prevents stale A-B-A navigation from stealing scrolling', () => {
  const previous = (globalThis as { window?: unknown }).window
  const frames: FrameRequestCallback[] = []
  ;(globalThis as { window?: unknown }).window = {
    requestAnimationFrame(callback: FrameRequestCallback) { frames.push(callback); return frames.length },
    cancelAnimationFrame() {},
  }
  let active = 'B'
  const pane = {
    scrollTop: 12,
    scrollHeight: 800,
    clientHeight: 200,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement
  try {
    settleReaderAtLatest(() => pane, () => active === 'A')
    frames.shift()?.(0)
    assert.equal(pane.scrollTop, 12)
    active = 'A'
    settleReaderAtLatest(() => pane, () => active === 'A')
    frames.shift()?.(0)
    assert.equal(pane.scrollTop, 600)
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
})

test('send positioning anchors to the latest user message, never the first round', () => {
  const row = { getBoundingClientRect: () => ({ top: 240 }) }
  const pane = {
    scrollTop: 320,
    scrollHeight: 1800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => ({ length: 1, item: () => row }),
  } as unknown as HTMLElement
  assert.equal(scrollReaderToLastUserTurn(pane), true)
  assert.equal(pane.scrollTop, 436)
})
