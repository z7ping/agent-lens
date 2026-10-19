import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTaskReading, type TaskReadingFact } from './task-reading-semantics'
import { coalesceLiveSemanticRounds } from './live-semantic-rounds'
import { projectLiveTaskRounds, type LiveTaskProjectionItem } from './live-task-projection'

test('过程、正文、用户请求在所有 Agent 上按原生语义归类，未知 assistant 不猜 final', () => {
  const facts: TaskReadingFact<string>[] = [
    { id: 'u', kind: 'prompt', value: '用户' },
    { id: 'r1', kind: 'reasoning', value: '思考' },
    { id: 't1', kind: 'tool', value: 'shell' },
    { id: 'c1', kind: 'commentary', value: '过程说明' },
    { id: 't2', kind: 'tool', value: 'read', error: true },
    { id: 'unknown', kind: 'unclassified-answer', value: '没有最终阶段字段的可见正文' },
    { id: 'final', kind: 'answer', value: '结论' },
  ]
  const result = projectTaskReading(facts)
  assert.deepEqual(result.prompts.map(item => item.id), ['u'])
  assert.deepEqual(result.process.map(item => item.id), ['r1', 't1', 'c1', 't2'])
  assert.deepEqual(result.answers.map(item => item.id), ['unknown', 'final'])
  assert.equal(result.answers[0]?.kind, 'unclassified-answer')
  assert.deepEqual(result.processCounts, { thinking: 1, commentary: 1, tools: 2, errors: 1 })
})

test('超过 1000 工具的单个语义轮只产生一个阅读轮次与过程容器', () => {
  const events: LiveTaskProjectionItem[] = [
    { id: 'user:one', kind: 'message', role: 'user', text: '检查', streaming: false },
    { id: 'thinking:one', kind: 'thinking', text: '思考', streaming: false },
    ...Array.from({ length: 1200 }, (_, i): LiveTaskProjectionItem => ({
      id: `tool:${i}`, kind: 'tool', callId: `call:${i}`, name: 'shell', status: 'success',
    })),
    { id: 'message:answer', kind: 'message', role: 'assistant', phase: 'final', text: '检查完成', streaming: false },
  ]
  const fragments = projectLiveTaskRounds(events)
  assert.equal(fragments.length, 1)
  assert.equal(fragments[0]?.items.length, events.length)
  const rounds = coalesceLiveSemanticRounds(fragments)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0]?.model.id, 'live-round:user:one')
  assert.equal(rounds[0]?.model.toolCount, 1200)
  assert.equal(rounds[0]?.items.length, events.length)
  assert.deepEqual(rounds[0]?.items.map(item => item.id), events.map(item => item.id))
})

test('不同用户轮次不能因为虚拟分块合并', () => {
  const events: LiveTaskProjectionItem[] = [
    { id: 'user:a', kind: 'message', role: 'user', text: 'A', streaming: false },
    ...Array.from({ length: 22 }, (_, i): LiveTaskProjectionItem => ({
      id: `a:${i}`, kind: 'tool', callId: `a:${i}`, name: 'read', status: 'success',
    })),
    { id: 'user:b', kind: 'message', role: 'user', text: 'B', streaming: false },
    { id: 'b:answer', kind: 'message', role: 'assistant', text: 'B result', streaming: false },
  ]
  const rounds = coalesceLiveSemanticRounds(projectLiveTaskRounds(events))
  assert.equal(rounds.length, 2)
  assert.deepEqual(rounds.map(x => x.model.semanticId), ['live-round:user:a', 'live-round:user:b'])
})
