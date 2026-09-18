import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearLiveComposerDraft,
  ComposerInputHistoryNavigator,
  liveComposerDraftKey,
  readLiveComposerDraft,
  writeLiveComposerDraft,
  type LiveComposerSessionStorage,
} from './live-composer-session-state'

class MemoryStorage implements LiveComposerSessionStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

test('Live Composer draft keys are isolated by live product and runtime', () => {
  assert.equal(
    liveComposerDraftKey('pi', 'runtime/1'),
    'agent-lens:live-composer:draft:v1:pi:runtime%2F1',
  )
  assert.notEqual(
    liveComposerDraftKey('pi', 'runtime-1'),
    liveComposerDraftKey('hermes', 'runtime-1'),
  )
})

test('Live Composer draft storage restores text and removes empty drafts', () => {
  const storage = new MemoryStorage()
  const key = liveComposerDraftKey('pi', 'runtime-1')

  assert.equal(readLiveComposerDraft(key, storage), '')
  assert.equal(writeLiveComposerDraft(key, '检查这段日志', storage), true)
  assert.equal(readLiveComposerDraft(key, storage), '检查这段日志')

  assert.equal(writeLiveComposerDraft(key, '   ', storage), true)
  assert.equal(readLiveComposerDraft(key, storage), '')

  assert.equal(writeLiveComposerDraft(key, '再次输入', storage), true)
  assert.equal(clearLiveComposerDraft(key, storage), true)
  assert.equal(readLiveComposerDraft(key, storage), '')
})

test('Composer input history starts from empty input and restores the original draft on ArrowDown', () => {
  const navigator = new ComposerInputHistoryNavigator()
  const history = ['first', 'second', 'third']

  assert.equal(navigator.previous(history, 'typing'), null)
  assert.equal(navigator.previous(history, ''), 'third')
  assert.equal(navigator.previous(history, 'third'), 'second')
  assert.equal(navigator.previous(history, 'second'), 'first')
  assert.equal(navigator.previous(history, 'first'), 'first')
  assert.equal(navigator.next(history), 'second')
  assert.equal(navigator.next(history), 'third')
  assert.equal(navigator.next(history), '')
  assert.equal(navigator.isActive(), false)
})

test('Composer input history reset stops ArrowDown from replacing edited text', () => {
  const navigator = new ComposerInputHistoryNavigator()
  assert.equal(navigator.previous(['one'], ''), 'one')
  assert.equal(navigator.isActive(), true)
  navigator.reset()
  assert.equal(navigator.next(['one']), null)
})
