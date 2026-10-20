import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskMessage } from './TaskMessage'
import { TaskEvent } from './TaskEvent'
import { TaskRound } from './TaskRound'
import { TaskToolGroup } from './TaskToolGroup'
import { TaskToolRow, taskShellCommandParts, taskToolTargetText } from './TaskToolRow'
import { TaskThinking } from './TaskThinking'
import { readableTaskHeaderTitle, taskRoundPreview, type TaskRoundModel, type TaskToolGroupModel } from './task-detail-model'

const toolGroup: TaskToolGroupModel = {
  id: 'tools:test', label: '工具执行', itemCount: 4, errorCount: 0, kindCounts: [],
  tools: [
    { id: 'read', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'packages/web/src/App.tsx', durationMs: 42 },
    { id: 'search', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'startedAt / capturedAt', durationMs: 51 },
    { id: 'test', name: 'run_checks', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'npm test packages/web', durationMs: 830 },
    { id: 'unknown', name: 'custom_native_call', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'opaque target' },
  ],
}
const round: TaskRoundModel = { id: 'round:test', label: '第 3 轮', state: 'settled', preview: '核对 Tool / Thinking / Message 层级', toolCount: 4, errorCount: 0, durationMs: 108_000, highLatency: false }

test('Tool Group 不新增整组详情层，仅收起超出前三项的普通调用', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  assert.match(html, /data-task-tool-group="true"/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 3)
  assert.match(html, /展开其余 1 项/)
})

test('测试类和未知 Tool 使用稳定语义降级', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup, defaultExpanded: true }))
  // npm test is only a native name, not evidence that the call belongs to
  // the 'test' tool kind. Both it and unknown calls remain generic.
  assert.doesNotMatch(html, /data-kind="test"/)
  assert.doesNotMatch(html, /task-tool-kind-test/)
  assert.equal((html.match(/data-kind="tool"/g) ?? []).length, 2)
  assert.match(html, />run_checks</)
  assert.match(html, />custom_native_call</)
})

test('Round 保持轻量摘要结构并默认展开', () => {
  const html = renderToStaticMarkup(createElement(TaskRound, { model: round, children: 'content' }))
  assert.match(html, /class="task-round interaction-block/)
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /task-round-label/)
  assert.match(html, /task-round-preview/)
  assert.match(html, /task-round-meta/)
  assert.match(html, /4 调用/)
})

test('任务页头清理 Markdown 强调语法，不修改存储的原始标题', () => {
  const title = '我准备发布**v1.0.0-alpha.6**版本，现在具备条件吗？'
  assert.equal(readableTaskHeaderTitle(title), '我准备发布v1.0.0-alpha.6版本，现在具备条件吗？')
  assert.equal(readableTaskHeaderTitle('## 检查 `npm test` 和 **文件变更**'), '检查 npm test 和 文件变更')
  assert.equal(readableTaskHeaderTitle(undefined), '')
  assert.equal(title, '我准备发布**v1.0.0-alpha.6**版本，现在具备条件吗？')
})

test('Round 预览将 Codex 文件上下文改为语义摘要且不改变原始消息', () => {
  const raw = '# Files mentioned by the user:\n## 患者服务平台部署指导手册.md:\nS:/hbs_tools/患者服务平台部署指导手册.md'
  assert.equal(taskRoundPreview(raw, '用户提及文件'), '用户提及文件')
  assert.equal(taskRoundPreview('## 修复 **Markdown** [预览](docs/README.md)', '用户提及文件'), '修复 Markdown 预览')
  assert.equal(taskRoundPreview('', '用户提及文件'), undefined)
  const html = renderToStaticMarkup(createElement(TaskRound, { model: { ...round, preview: raw }, children: 'content' }))
  assert.match(html, /data-round-preview="用户提及文件"/)
  assert.doesNotMatch(html, /Files mentioned by the user/)
  const message = renderToStaticMarkup(createElement(TaskMessage, { role: 'user', text: raw, collapsible: false }))
  assert.match(message, /Files mentioned by the user/)
})

test('Round 折叠时不挂载轮次正文', () => {
  const html = renderToStaticMarkup(createElement(TaskRound, { model: round, defaultExpanded: false, children: 'content' }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.doesNotMatch(html, /task-round-flow/)
  assert.doesNotMatch(html, />content</)
})

test('用户保留右侧气泡，Agent 无头像且不恢复历史视觉别名', () => {
  const user = renderToStaticMarkup(createElement(TaskMessage, { role: 'user', text: '用户消息', collapsible: false }))
  const assistant = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: '智能体回复', modelLabel: 'test / model-1', collapsible: false }))
  assert.match(user, /task-message-row task-message-user/)
  assert.match(user, /task-message-bubble-user/)
  assert.doesNotMatch(user, />源码</)
  assert.match(assistant, /task-message-row task-message-assistant/)
  assert.match(assistant, /task-message-bubble-assistant/)
  assert.match(assistant, /task-message-model-meta/)
  assert.match(assistant, /test \/ model-1/)
  assert.match(assistant, /lucide-file-code/)
  assert.match(assistant, /task-message-copy-action/)
  assert.match(assistant, /aria-label="查看 Markdown 源码"/)
  assert.doesNotMatch(user, /class="(?:message-row|chat-bubble)(?:\s|\")/)
  assert.doesNotMatch(assistant, /class="(?:message-row|chat-bubble)(?:\s|\")/)
})

test('默认 Tool 摘要一行展示类型、名称和状态图标，原始数据只在展开后出现', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup, defaultExpanded: true }))
  assert.equal((html.match(/<summary class="task-tool-row"/g) ?? []).length, 4)
  assert.equal((html.match(/<details class="task-tool-call/g) ?? []).length, 4)
  assert.doesNotMatch(html, /<details class="task-tool-call[^>]*open=""/)
  assert.match(html, /task-tool-summary-text/)
  assert.match(html, /task-tool-status-mark/)
  assert.match(html, /task-tool-row-chevron/)
})

test('assistant controls have no invisible status spacer after streaming settles', () => {
  const html = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: 'rendered answer', collapsible: false }))
  assert.doesNotMatch(html, /task-message-output-state/)
  assert.match(html, /task-message-copy-action/)
  assert.match(html, /aria-label="查看 Markdown 源码"/)
})

test('thinking title uses a measured duration only and does not masquerade as execution time', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, {
    model: { id: 'reasoning', label: '思考过程', text: 'work', durationMs: 83_000, state: 'settled' },
    defaultExpanded: false,
    children: 'work',
  }))
  assert.match(html, /思考了 1分23秒/)
  assert.match(html, /task-thinking-kind-mark/)
  const unknown = renderToStaticMarkup(createElement(TaskThinking, {
    model: { id: 'reasoning-unknown', label: '思考过程', text: 'work' },
    defaultExpanded: false, children: 'work',
  }))
  assert.match(unknown, /思考过程/)
  assert.doesNotMatch(unknown, /思考了/)
})

test('已验证的 Pi MCP 以服务器和工具名展示，未确认来源不得伪装 MCP', () => {
  const trusted: TaskToolGroupModel = {
    ...toolGroup,
    tools: [{
      id: 'trusted-mcp', name: 'mcp__dbx__execute_query', kind: 'tool',
      kindLabel: '工具', toolSourceType: 'mcp', mcpServerId: 'dbx',
      status: 'success', output: 'ok',
    }],
    itemCount: 1,
  }
  const trustedHtml = renderToStaticMarkup(createElement(TaskToolGroup, { model: trusted }))
  assert.match(trustedHtml, /data-kind="mcp"/)
  assert.match(trustedHtml, /dbx · execute_query/)
  const unknown: TaskToolGroupModel = {
    ...trusted,
    tools: [{ ...trusted.tools[0]!, id: 'unknown', toolSourceType: undefined, mcpServerId: undefined }],
  }
  const unknownHtml = renderToStaticMarkup(createElement(TaskToolGroup, { model: unknown }))
  assert.match(unknownHtml, /data-kind="tool"/)
  assert.doesNotMatch(unknownHtml, /dbx · execute_query/)
})

test('MCP 完整入参与出参位于同一个默认折叠的 Tool 内，不被再次套娃', () => {
  const input = JSON.stringify({ database: 'auth-center-v3', sql: 'SELECT * FROM organization WHERE ancestors LIKE ?', args: ['%sample%'] })
  const data: TaskToolGroupModel = { ...toolGroup, tools: [
    { id: 'mcp', name: 'dbx_execute_query', kind: 'mcp', kindLabel: 'MCP', status: 'success', primary: input.slice(0, 30), rawInput: input, output: '{"rows":[{"id":1}]}' },
  ], itemCount: 1 }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: data }))
  assert.match(html, /<details class="task-tool-call/)
  assert.doesNotMatch(html, /<details class="task-tool-call[^>]*open=""/)
  assert.match(html, /data-tool-section="input"/)
  assert.match(html, /data-tool-section="output"/)
  assert.doesNotMatch(html, /task-tool-input-details|task-tool-output-details/)
  assert.match(html, /organization WHERE ancestors LIKE/)
  assert.match(html, /rows/)
})


test('事件类型分别使用语义图标，不再全部显示时钟', () => {
  const cases = [
    ['permission', 'lucide-shield'],
    ['subagent', 'lucide-git-fork'],
    ['context', 'lucide-layers'],
    ['model', 'lucide-bot'],
    ['lifecycle', 'lucide-clock'],
    ['artifact', 'lucide-folder-open'],
    ['unknown', 'lucide-circle-alert'],
  ] as const
  for (const [category, expected] of cases) {
    const html = renderToStaticMarkup(createElement(TaskEvent, { model: { id: category, category, label: category } }))
    assert.match(html, new RegExp(expected), category)
  }
})

test('TaskMessage 的额外操作与核心复制/源码操作各有可达入口', () => {
  const html = renderToStaticMarkup(createElement(TaskMessage, {
    role: 'assistant', text: '结果', actions: createElement('button', { type: 'button' }, '编辑消息'),
  }))
  assert.match(html, /task-message-actions/)
  assert.match(html, /编辑消息/)
  assert.match(html, /task-message-copy-action/)
})

test('Shell 默认是一行图标 + bash + 命令，失败状态留在右侧', () => {
  const html = renderToStaticMarkup(createElement(TaskToolRow, {
    model: {
      id: 'shell-failed', name: 'bash', kind: 'shell', kindLabel: 'Shell',
      status: 'error', primary: 'cd /workspace && rg -n "feature" src | head -30',
      output: 'command failed',
    },
  }))
  const summary = html.match(/<summary class="task-tool-row"[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? ''
  assert.match(html, /data-kind="shell" data-command="true"/)
  assert.match(summary, /task-tool-kind-shell/)
  assert.match(summary, /class="task-tool-summary-text"[^>]*>bash<\/span>/)
  assert.match(summary, /task-tool-command-context"[^>]*>cd \/workspace &amp;&amp;<\/span>/)
  assert.match(summary, /task-tool-command-preview/)
  assert.match(summary, /rg -n/)
  assert.match(summary, /task-tool-status-error/)
  assert.ok(summary.indexOf('task-tool-command-preview') < summary.indexOf('task-tool-status-error'))
  assert.doesNotMatch(summary, />Shell<\/span>/)
  assert.equal((summary.match(/task-tool-command-preview/g) ?? []).length, 1)
  assert.match(html, /data-tool-section="input"/)
  assert.match(html, /data-tool-section="output"/)
})

test('Read/Search 优先使用原生入参目标，不再重复“读取 read”“搜索 memory_search”', () => {
  const group: TaskToolGroupModel = { ...toolGroup, itemCount: 4, tools: [
    { id: 'r-path', kind: 'read', kindLabel: '读取', name: 'read', status: 'success',
      rawInput: JSON.stringify({ file_path: 'src/menu.ts' }), primary: 'read' },
    { id: 's-query', kind: 'search', kindLabel: '搜索', name: 'memory_search', status: 'success',
      primary: '{"query":"小程序权限菜单","limit":10}' },
    { id: 'r-no-target', kind: 'read', kindLabel: '读取', name: 'read', status: 'success', primary: 'read' },
    { id: 'r-opaque', kind: 'read', kindLabel: '读取', name: 'read', status: 'success',
      rawInput: '{"line":40}', primary: '{"line":40}' },
  ] }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: group, defaultExpanded: true }))
  assert.equal((html.match(/class="task-tool-preview-slot"/g) ?? []).length, 4)
  assert.match(html, /class="task-tool-target" title="src\/menu.ts">src\/menu.ts/)
  assert.match(html, /class="task-tool-target" title="小程序权限菜单">小程序权限菜单/)
  assert.doesNotMatch(html, />读取<\/span>|>搜索<\/span>/)
  assert.equal((html.match(/class="task-tool-target"/g) ?? []).length, 2)
  assert.match(html, /task-tool-summary-text" title="read">read/)
  assert.match(html, /task-tool-summary-text" title="memory_search">memory_search/)
})

test('目标提取仅来自可信输入字段，Shell cd 前缀只调整显示明暗且原文无损', () => {
  const base = { id: 'read', name: 'read', kind: 'read' as const, kindLabel: '读取', status: 'success' as const }
  assert.equal(taskToolTargetText({ ...base, primary: 'read' }, 'read'), '')
  assert.equal(taskToolTargetText({ ...base, rawInput: '{"line":5}', primary: '{"line":5}' }, 'read'), '')
  assert.equal(taskToolTargetText({ ...base, rawInput: '{"file_path":"lib/a.ts"}' }, 'read'), 'lib/a.ts')
  assert.equal(taskToolTargetText({ ...base, name: 'memory_search', kind: 'search', kindLabel: '搜索',
    rawInput: '{"arguments":{"query":"agent lens"}}' }, 'search'), 'agent lens')
  assert.equal(taskToolTargetText({ ...base, name: 'memory_search', kind: 'search', kindLabel: '搜索',
    rawInput: JSON.stringify({ arguments: JSON.stringify({ query: '已有记录' }) }) }, 'search'), '已有记录')
  for (const input of [
    'cd E:/workspace && rg -n "menu" src',
    'cd "E:/my && projects" && npm test',
    'cd /e && python script.py',
    'python -c "print(1)"',
  ]) {
    const parts = taskShellCommandParts(input)
    assert.equal(parts.prefix + parts.command, input)
  }
  assert.equal(taskShellCommandParts('cd "E:/my && projects" && npm test').prefix,
    'cd "E:/my && projects" &&')
  assert.equal(taskShellCommandParts('python -c "print(1)"').prefix, '')
})
