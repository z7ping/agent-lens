import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorStateBanner } from './StateViews'
import { LiveRuntimeActions } from './LiveRuntimeDisclosures'

test('失败恢复横幅展示真实错误并复用可禁用的贡献操作，保留本地化文案', () => {
  const item = {
    contributionId: 'runtime-diagnostics',
    title: { default: 'Runtime' },
    fields: [],
    actions: [{ actionId: 'runtime.retry', label: { default: 'Retry', localizations: { 'zh-CN': '重试' } }, tone: 'primary' as const }],
  }
  const html = renderToStaticMarkup(createElement(ErrorStateBanner, {
    title: '会话执行失败', message: '关键事件队列溢出', showDoctor: false,
    actions: createElement(LiveRuntimeActions, { item, language: 'zh-CN', pendingAction: 'runtime.retry', onAction: () => {} }),
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /会话执行失败/)
  assert.match(html, /关键事件队列溢出/)
  assert.match(html, /disabled=""[^>]*>重试<\/button>/)
  assert.doesNotMatch(html, /agent-lens doctor/)
})

test('失败恢复入口位于会话底部输入区上方，无需滚回启动诊断', () => {
  const page = readFileSync(new URL('../features/LiveTaskPage.tsx', import.meta.url), 'utf8')
  const compose = page.indexOf('className="task-session-composer-slot"')
  const banner = page.indexOf('<ErrorStateBanner', compose)
  const input = page.indexOf('<TaskSessionComposer', compose)
  assert.ok(compose > 0 && banner > compose && input > banner)
  assert.match(page.slice(compose, input), /state\?\.status === 'failed'/)
  assert.match(page.slice(banner, input), /<LiveRuntimeActions/)
})
