import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test from 'node:test'
import { auditTaskSessionOwnership } from './task-session-ownership.mjs'

function fixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'agentlens-session-gate-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const sharedReaders = {
  'features/LiveTaskTimeline.tsx': "import { TaskSessionMessage } from './TaskSessionContent'\nexport const View = () => <TaskSessionMessage role=\"user\" text=\"ok\" />",
  'features/ReviewRoundPresentation.tsx': "import { TaskSessionMessage } from './TaskSessionContent'\nexport const View = () => <TaskSessionMessage role=\"user\" text=\"ok\" />",
  'features/TaskSessionContent.tsx': "export const Msg = () => <TaskMessage text=\"ok\" />",
}

test('统一渲染器与合法原生 CSS 所有者允许通过', () => {
  fixture({
    ...sharedReaders,
    'task-detail.css': '.task-message-row { color: inherit } @media (max-width: 992px) { .task-thinking-summary { display: block } }',
    'components/valid.css': '.task-header { margin: 0 }',
  }, root => assert.deepEqual(auditTaskSessionOwnership(root), []))
})

test('扫描新增子目录 TSX，拒绝自建 Task 消息与变相 DOM', () => {
  fixture({
    ...sharedReaders,
    'features/codex/AltSessionView.tsx': 'export const View = () => <TaskMessage text="other" />',
    'features/another-agent/NewView.tsx': 'export const View = () => <div className="task-message-row">body</div>',
    'features/hermes/HermesMessage.tsx': 'export const View = () => <article className="hermes-live-message">body</article>',
  }, root => {
    const errors = auditTaskSessionOwnership(root).join('\n')
    assert.match(errors, /AltSessionView.tsx.*TaskMessage/)
    assert.match(errors, /NewView.tsx.*task-message-row/)
    assert.match(errors, /HermesMessage.tsx.*私有/)
  })
})

test('共享 Live/Review 入口禁止退回独立 Task 原语', () => {
  fixture({
    ...sharedReaders,
    'features/LiveTaskTimeline.tsx': 'export const View = () => <TaskProcessGroup />',
  }, root => {
    const errors = auditTaskSessionOwnership(root).join('\n')
    assert.match(errors, /LiveTaskTimeline.tsx.*缺少共享/)
    assert.match(errors, /LiveTaskTimeline.tsx.*TaskProcessGroup/)
  })
})

test('扫描嵌套目录和 @media CSS，拒绝共享组件选择器被重写', () => {
  fixture({
    ...sharedReaders,
    'components/custom/private.css': '@media (max-width: 992px) { .task-tool-row { padding: 100px } }',
    'features/codex/extra.css': '.codex-live-thinking { color: red }',
    'components/unrelated.css': '/* .task-message-row { not a rule } */ .my-card { content: ".task-thinking" }',
  }, root => {
    const errors = auditTaskSessionOwnership(root).join('\n')
    assert.match(errors, /private\.css.*task-tool-row/)
    assert.match(errors, /extra\.css.*智能体私有/)
    assert.doesNotMatch(errors, /unrelated\.css/)
  })
})

test('兼容 Pi 旧入口仅允许在既有文件内继续使用，不放宽新增实现', () => {
  fixture({
    ...sharedReaders,
    'features/PiLiveTaskRound.tsx': 'export const Old = () => <TaskProcessGroup><TaskMessage text="legacy"/></TaskProcessGroup>',
    'features/PiSessionCopy.tsx': 'export const Copy = () => <TaskProcessGroup />',
  }, root => assert.match(auditTaskSessionOwnership(root).join('\n'), /PiSessionCopy\.tsx.*TaskProcessGroup/))
})
