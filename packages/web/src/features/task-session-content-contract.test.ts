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
  // Groups of consecutive calls are progressively disclosed by one shared ToolGroup
  // in both modes; Review adds evidence/inspect callbacks, never a second renderer.
  const group = read('./TaskToolGroup.tsx')
  assert.match(live, /<TaskToolGroup/)
  assert.match(review, /<TaskToolGroup/)
  assert.match(live, /compact[\s\S]*?model=\{\{/)
  assert.match(review, /compact[\s\S]*?model=\{\{/)
  assert.match(review, /renderMeta=\{tool =>/)
  assert.match(review, /onToolClick=\{tool =>/)
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

test('通用错误诊断只由共享 TaskMessage 渲染且只消费确证字段', () => {
  const html = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: 'Provider rejected request', error: true,
    errorDiagnostic: {
      stage: 'model', code: 'E_MODEL', retryable: false, guidance: 'Select a supported model',
    },
  }))
  assert.match(html, /task-message-error-diagnostic/)
  assert.match(html, /E_MODEL/)
  assert.match(html, /Select a supported model/)
  const plain = renderToStaticMarkup(createElement(TaskSessionMessage, {
    role: 'assistant', text: 'Provider rejected request', error: true,
  }))
  assert.doesNotMatch(plain, /task-message-error-diagnostic/)
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
  assert.match(messageSource, /\(modelLabel \|\| time \|\| meta\)/)
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
