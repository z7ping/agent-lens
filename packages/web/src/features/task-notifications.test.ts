import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import { projectTaskNotification, taskNotifications } from './task-notifications'

function envelope(liveId: string, normalizedEvent: NonNullable<LiveRuntimeEventDto['normalizedEvent']>, sequence = 1) {
  return { liveId, runtimeSessionId: 'session/1', event: {
    runtimeSessionId: 'session/1', sequence, receivedAt: '2026-10-21T10:00:00Z', event: {}, normalizedEvent,
  } satisfies LiveRuntimeEventDto }
}

test('native Pi notify retains its id, source and severity', () => {
  const item = projectTaskNotification(envelope('pi', {
    type: 'notification', id: 'native-1', message: '后台任务完成', level: 'success',
  }), '/review')
  assert.equal(item?.id, 'pi:session/1:native-1')
  assert.equal(item?.level, 'success')
  assert.equal(item?.read, false)
})

test('terminal turns from the foreground are not notifications', () => {
  const turn = envelope('codex', { type: 'completed', status: 'completed' })
  assert.equal(projectTaskNotification(turn, '/review/live/codex/session%2F1'), null)
  assert.equal(projectTaskNotification(turn, '/review')?.level, 'success')
  assert.equal(projectTaskNotification(envelope('codex', { type: 'completed', status: 'interrupted' }), '/review'), null)
})

test('action requests alert without guessing from tool or token deltas', () => {
  const action = projectTaskNotification(envelope('codex', {
    type: 'ui.request', requestId: 'request-2', method: 'confirm', message: 'Permission required',
  }), '/review')
  assert.equal(action?.level, 'action')
  assert.equal(action?.id, 'codex:session/1:request-2')
  assert.equal(projectTaskNotification(envelope('pi', { type: 'tool.end', status: 'success' }), '/review'), null)
  assert.equal(projectTaskNotification(envelope('pi', { type: 'text.delta', delta: 'x' }), '/review'), null)
})

test('notification store deduplicates native ids and tracks read and dismissed banner separately', () => {
  const item = projectTaskNotification(envelope('pi', {
    type: 'notification', id: 'test-dedup-571', message: 'done', level: 'success',
  }), '/review')!
  const before = taskNotifications.getSnapshot().items.length
  taskNotifications.push(item)
  taskNotifications.push(item)
  assert.equal(taskNotifications.getSnapshot().items.length, before + 1)
  assert.equal(taskNotifications.getSnapshot().bannerId, item.id)
  taskNotifications.dismissBanner(item.id)
  assert.equal(taskNotifications.getSnapshot().bannerId, null)
  assert.equal(taskNotifications.getSnapshot().items[0]?.read, false)
  taskNotifications.markRead(item.id)
  assert.equal(taskNotifications.getSnapshot().items[0]?.read, true)
})
