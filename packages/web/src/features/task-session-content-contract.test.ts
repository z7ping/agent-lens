import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskSessionMessage, TaskSessionProcess, TaskSessionThinking, TaskSessionTool, TaskSessionProcessText, taskSessionMessageTime } from './TaskSessionContent'
import type { TaskThinkingModel, TaskToolModel } from './task-detail-model'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Live 和 Review 共用消息、思考、工具、过程与文本渲染入口，页面不得重建 JSX', () => {
  const live = read('./LiveTaskTimeline.tsx')
  const review = read('./ReviewRoundPresentation.tsx')
  for (const [component, pattern] of [
    ['TaskSessionMessage', /<TaskSessionMessage/],
    ['TaskSessionThinking', /<TaskSessionThinking/],
    ['TaskSessionProcessText', /<TaskSessionProcessText/],
    ['TaskSessionProcess', /<TaskSessionProcess/],
  ] as const) {
    assert.match(live, pattern, 'Live must use the common ' + component)
    assert.match(review, pattern, 'Review must use the common ' + component)
  }
  assert.doesNotMatch(live, /<TaskMessage|<TaskThinking|<TaskToolRow|<TaskProcessGroup|<MarkdownContent/)
  assert.doesNotMatch(review, /<TaskToolRow|<TaskMessage|<TaskProcessGroup|<MarkdownContent/)
  assert.match(live, /<TaskSessionProcess\s+mode="live"/)
  assert.match(review, /<TaskSessionProcess\s+mode="review"/)
  // Live / Review share the same adjacency-aware grouping owner.
  const group = read('./TaskToolGroup.tsx')
  assert.match(live, /<TaskProcessSequence/)
  assert.match(review, /<TaskProcessSequence/)
  assert.match(group, /splitAdjacentTaskToolEntries/)
  assert.match(group, /<TaskToolGroup/)
  assert.match(group, /visibleTaskToolIds\(tools, expanded\)/)
  assert.match(group, /index < TASK_TOOL_PREVIEW_LIMIT \|\| tool\.status === 'running' \|\| tool\.status === 'error'/)
  assert.match(read('./TaskSessionContent.tsx'), /return <TaskToolRow model=\{model\} compact/)
  assert.match(live, /<TaskSessionTool/)
  const css = read('../task-detail.css')
  assert.match(css, /\.task-surface \.task-tool-group \{/)
  assert.match(css, /\.task-surface \.task-tool-group-toggle \{/)
  assert.match(css, /\.task-surface \.task-tool-group \.task-tool-list \{/)
  assert.doesNotMatch(read('../live-task.css'), /\.task-tool-group(?:\b|[.#:{])/)
  assert.doesNotMatch(read('../review.css'), /\.task-tool-group(?:\b|[.#:{])/)
  assert.doesNotMatch(read('../live-task.css'), /\.pi-live-(?:message|thinking|tool|process)(?:\s|[.#:{])/)
  assert.doesNotMatch(read('../review.css'), /\.review-(?:message|thinking|tool|process)(?:\s|[.#:{])/)
})

test('相同的 Session 事实在两种模式中只有一份 DOM 结构', () => {
  const message = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: '共同消息', collapsible: false,
  }))
  assert.match(message, /task-message-assistant/)
  const processText = renderToStaticMarkup(createElement(TaskSessionProcessText, {
    text: '处理输出',
  }))
  assert.match(processText, /task-process-message/)
  assert.match(processText, /markdown-message/)

  const tool: TaskToolModel = {
    id: 'command-one',
    name: 'shell',
    kind: 'shell',
    kindLabel: '命令',
    status: 'success',
    primary: 'echo ok',
    output: 'ok',
  }
  const toolHtml = renderToStaticMarkup(createElement(TaskSessionTool, { model: tool }))
  assert.match(toolHtml, /task-tool-call/)
  assert.match(toolHtml, /<summary/)
  assert.doesNotMatch(toolHtml, /task-tool-group/)
  assert.doesNotMatch(toolHtml, /data-tool-section="input"/)

  const sharedProps = {
    id: 'process-one', messageCount: 1, thinkingCount: 1, toolCount: 1,
    state: 'settled' as const,
  }
  const review = renderToStaticMarkup(createElement(TaskSessionProcess, {
    ...sharedProps, mode: 'review', children: '内容',
  }))
  const live = renderToStaticMarkup(createElement(TaskSessionProcess, {
    ...sharedProps, mode: 'live', children: '内容',
  }))
  assert.equal(review, live)
  const runningLive = renderToStaticMarkup(createElement(TaskSessionProcess, {
    ...sharedProps, state: 'running', mode: 'live', children: '内容',
  }))
  assert.match(runningLive, /<details[^>]*open/)
  const runningReview = renderToStaticMarkup(createElement(TaskSessionProcess, {
    ...sharedProps, state: 'running', mode: 'review', children: '内容',
  }))
  assert.doesNotMatch(runningReview, /<details[^>]*open/)
})

test('失败模型请求复用共享 TaskMessage，以错误语义呈现，不冒充正常答复', () => {
  const rendered = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: 'HTTP 422: developer role is not supported', error: true,
    presentation: { author: 'Pi' },
  }))
  assert.match(rendered, /data-error="true"/)
  assert.match(rendered, /role="alert"/)
  assert.match(rendered, /task-message-error-status/)
  assert.match(rendered, /HTTP 422: developer role is not supported/)
  const normal = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: '完成', presentation: { author: 'Pi' },
  }))
  assert.doesNotMatch(normal, /data-error="true"/)
  assert.match(read('../task-detail.css'), /task-message-row\[data-error='true'\]/)
})

test('Live 和 Review 的消息辅助信息共用一套字段模型，不因缺少 modelLabel 隐藏时间与证据', () => {
  const evidence = createElement('span', {}, '证据 2 条')
  const html = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant',
    text: '已完成任务',
    presentation: { author: 'Pi', time: '21:40:00', evidence },
  }))
  assert.equal((html.match(/class="task-message-model-meta"/g) ?? []).length, 1)
  assert.match(html, /<b>Pi<\/b>/)
  assert.match(html, /证据 2 条/)
  assert.match(html, /<time>21:40:00<\/time>/)
  assert.ok(html.indexOf('证据 2 条') < html.indexOf('<time>21:40:00'))
  assert.doesNotMatch(html, /task-message-model-label/)
  const noEvidence = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: '正文', presentation: { author: 'Codex' },
  }))
  assert.doesNotMatch(noEvidence, /class="task-message-model-meta"/)
  assert.equal(taskSessionMessageTime(undefined), undefined)
  assert.equal(taskSessionMessageTime('not-a-date'), undefined)
  assert.match(taskSessionMessageTime('2026-10-19T12:00:00Z') ?? '', /\d{2}:\d{2}:\d{2}/)
  for (const source of ['./LiveTaskTimeline.tsx', './ReviewRoundPresentation.tsx']) {
    assert.match(read(source), /presentation=\{\{/)
    assert.match(read(source), /taskSessionMessageTime/)
  }
  const messageSource = read('./TaskMessage.tsx')
  assert.match(messageSource, /\(modelLabel \|\| time \|\| meta \|\| error\)/)
  assert.doesNotMatch(messageSource, /!user && modelLabel &&/)
  assert.match(read('../task-detail.css'), /\.task-surface \.task-message-context-evidence/)
  assert.doesNotMatch(read('../review.css'), /\.task-message-model-meta/)
  assert.doesNotMatch(read('../live-task.css'), /\.task-message-model-meta/)
})

test('真实桌面验收使用唯一的 Session Process 选择器，避免重构后假超时', () => {
  const acceptance = read('../../../../scripts/acceptance/task-center-desktop.mjs')
  const process = read('./TaskProcessGroup.tsx')
  const session = read('./TaskSessionContent.tsx')
  assert.match(session, /return <TaskProcessGroup/)
  assert.match(process, /className=\{`task-process-group/)
  assert.match(acceptance, /pane\?\.querySelector\('\.task-process-group'\)/)
  assert.doesNotMatch(acceptance, /querySelector\('\.task-review-process'\)/)
  assert.match(acceptance, /processExpanded: process instanceof HTMLDetailsElement && process\.open/)
  assert.match(acceptance, /JSON\.stringify\(lastState\)/)
})

test('只有可信 reasoning 区间才显示思考时长，不能借用过程或轮次耗时', () => {
  const base: TaskThinkingModel = {
    id: 'thought-one', label: '思考过程', text: '分析任务', state: 'settled',
  }
  const unknown = renderToStaticMarkup(createElement(TaskSessionThinking, { model: base }))
  assert.doesNotMatch(unknown, /task-thinking-duration/)
  for (const invalid of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const rendered = renderToStaticMarkup(createElement(TaskSessionThinking, {
      model: { ...base, durationMs: invalid },
    }))
    assert.doesNotMatch(rendered, /task-thinking-duration/)
  }
  const measured = renderToStaticMarkup(createElement(TaskSessionThinking, {
    model: { ...base, durationMs: 12_300 },
  }))
  assert.match(measured, /task-thinking-duration/)
  assert.match(read('./live-task-projection.ts'), /event\.type === 'reasoning\.end'[\s\S]*?startedAtMs !== undefined/)
  assert.doesNotMatch(read('./ReviewRoundPresentation.tsx'), /durationMs:\s*round\.durationMs/)
})

test('Review/Live 共享头部使用 Agent Logo；历史证据与实时输入保持模式特性', () => {
  assert.match(read('./ReviewPage.tsx'), /marker=\{<AgentLogo sourceId=/)
  assert.match(read('./LiveTaskPage.tsx'), /marker=\{<AgentLogo sourceId=/)
  assert.match(read('./ReviewRoundPresentation.tsx'), /meta=\{<EvidenceBadges/)
  assert.match(read('./LiveTaskPage.tsx'), /<TaskSessionComposer/)
})

test('Task Surface 字号只有 typography.css 一处语义源，Live/Review 不保留像素硬编码', () => {
  const typography = read('../typography.css')
  const detail = read('../task-detail.css')
  const sessionView = read('../task-session-view.css')
  const sizes = [
    ['body', 'var(--text-body)'],
    ['process', 'var(--text-secondary)'],
    ['thinking-markdown', 'var(--text-task-body)'],
    ['tool', 'var(--text-secondary)'],
    ['tool-code', 'var(--text-task-tool)'],
    ['code', 'var(--text-caption)'],
    ['meta', 'var(--text-caption)'],
    ['heading', 'var(--text-section-title)'],
    ['emphasis', '15px'],
  ] as const
  for (const [role, value] of sizes) {
    assert.ok(typography.includes(`--text-task-${role}:${value};`), `Task typography role missing: ${role}`)
  }

  // Changing a single role must reach the real Task owner, not a later page override.
  for (const selector of [
    '.task-message-content .markdown { font-size: var(--text-task-body); }',
    '.task-thinking-content .markdown { font-size: var(--text-task-thinking-markdown); }',
    '.task-tool-summary-text {',
  ]) assert.ok(detail.includes(selector), `Task owner missing: ${selector}`)
  assert.match(detail, /\.task-thinking-content \{[^}]*font-size: var\(--text-task-process\)/)
  assert.match(detail, /\.task-tool-call > summary\.task-tool-row \{[^}]*font: var\(--text-task-tool\)/)
  assert.match(detail, /\.task-surface \.markdown pre,[\s\S]*?font: var\(--text-task-code\)/)
  assert.match(sessionView, /\.task-header-title \{[^}]*font-size: var\(--text-task-emphasis\)/)

  const known = new Set<string>(sizes.map(([role]) => `--text-task-${role}`))
  const refs = [...detail.matchAll(/var\((--text-task-[a-z-]+)\)/g)].map(match => match[1]!)
  assert.ok(refs.length >= 60)
  for (const ref of refs) assert.ok(known.has(ref), `Undefined Task font token: ${ref}`)
  assert.doesNotMatch(detail, /font-size:\s*\d+(?:\.\d+)?px\b/)
  assert.doesNotMatch(detail, /\bfont:\s*(?:\d{3}\s+)?\d+(?:\.\d+)?px\//)
  assert.doesNotMatch(sessionView, /\.task-header-title \{[^}]*font-size:\s*15px/)
  assert.doesNotMatch(read('../live-task.css'), /--text-task-[a-z-]+\s*:/)
  assert.doesNotMatch(read('../review.css'), /--text-task-[a-z-]+\s*:/)
})

test('Task reading typography has three viewport tiers and never enlarges navigation', () => {
  const typography = read('../typography.css')
  const owner = read('../task-detail.css')
  const surface = read('./TaskSurface.tsx')
  assert.match(surface, /sessionMode = mode === 'review' \|\| mode === 'live'/)
  assert.match(surface, /'task-surface', sessionMode \? 'task-session-view'/)

  // Changes are scoped to the shared session surface, not the global :root scale.
  assert.match(typography, /\.task-surface\.task-session-view \{\s*--text-task-body:15px;\s*--text-task-thinking-markdown:13px;\s*\}/)
  assert.match(typography, /@media \(min-width: 768px\) \{\s*\.task-surface\.task-session-view \{\s*--text-task-process:var\(--font-size-md\);\s*--text-task-thinking-markdown:var\(--text-task-process\);\s*--text-task-code:var\(--font-size-sm\);\s*\}\s*\}/)
  assert.match(typography, /@media \(min-width: 1400px\) \{\s*\.task-surface\.task-session-view \{\s*--text-task-body:var\(--font-size-lg\);\s*--text-task-tool:var\(--font-size-md\);\s*\}\s*\}/)

  assert.match(owner, /\.task-message-content \.markdown \{ font-size: var\(--text-task-body\); \}/)
  assert.match(owner, /\.task-thinking-content \.markdown \{ font-size: var\(--text-task-thinking-markdown\); \}/)
  assert.match(owner, /\.task-process-message \.markdown \{ font-size: var\(--text-task-process\); \}/)
  assert.match(owner, /\.task-tool-call > summary\.task-tool-row \{[^}]*font: var\(--text-task-tool\)/)
  assert.match(owner, /\.task-surface \.markdown pre,[\s\S]*?font: var\(--text-task-code\)/)
  // Metadata and fixed control typography must remain on their existing scale.
  assert.match(typography, /--text-task-meta:var\(--text-caption\);/)
  assert.doesNotMatch(typography, /--text-body:\s*(?:15|16)px/)
  assert.doesNotMatch(read('../live-task.css'), /--text-task-(?:body|process|tool|code)\s*:/)
  assert.doesNotMatch(read('../review.css'), /--text-task-(?:body|process|tool|code)\s*:/)
})
