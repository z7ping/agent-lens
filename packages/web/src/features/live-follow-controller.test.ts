import test from 'node:test'
import assert from 'node:assert/strict'
import type { LiveTaskProjectionItem } from './live-task-projection'
import { LiveFollowController, liveFollowTextRevision } from './live-follow-controller'

const message = (text: string): LiveTaskProjectionItem => ({
  id: 'message:a1:0', kind: 'message', role: 'assistant', text, streaming: true,
})

test('工具增量和思考文本不会驱动 Live 阅读区跟随', () => {
  const stable: LiveTaskProjectionItem[] = []
  const before: LiveTaskProjectionItem[] = [
    message('正文稳定'),
    { id: 'tool:1', kind: 'tool', callId: '1', name: 'shell', output: 'a', status: 'running' },
  ]
  const after: LiveTaskProjectionItem[] = [
    message('正文稳定'),
    { id: 'tool:1', kind: 'tool', callId: '1', name: 'shell', output: 'a'.repeat(2_000), status: 'running' },
    { id: 'thinking:1', kind: 'thinking', text: 'new thinking', streaming: true },
  ]
  assert.equal(liveFollowTextRevision(stable, before), liveFollowTextRevision(stable, after))
})

test('新正文和正文继续增长才触发自动跟随', () => {
  const first = liveFollowTextRevision([], [message('正文')])
  const second = liveFollowTextRevision([], [message('正文更新')])
  const third = liveFollowTextRevision([], [
    message('正文更新'),
    { id: 'user:next', kind: 'message', role: 'user', text: '下一轮', streaming: false },
  ])
  assert.notEqual(first, second)
  assert.notEqual(second, third)
})

test('用户上滑立即解除 follow，必须明确恢复才继续', () => {
  const follow = new LiveFollowController()
  follow.markUserIntent()
  assert.equal(follow.observeScroll(500), false)
  assert.equal(follow.isFollowing, false)
  follow.restore()
  assert.equal(follow.isFollowing, true)
})
