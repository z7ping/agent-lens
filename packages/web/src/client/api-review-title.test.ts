import assert from 'node:assert/strict'
import test from 'node:test'
import { preferUserSessionTitle } from './api'

test('会话列表默认使用首条用户消息表达任务意图', () => {
  const result = preferUserSessionTitle({
    title: '来源提供的旧标题',
    preview: '请检查 Windows 安装器图标问题',
  })
  assert.equal(result.title, '请检查 Windows 安装器图标问题')
  assert.equal(result.preview, '请检查 Windows 安装器图标问题')
})

test('首条用户消息缺失时保留工具或历史数据提供的标题', () => {
  const result = preferUserSessionTitle({
    title: 'OpenCode 原生会话摘要',
    preview: '   ',
  })
  assert.equal(result.title, 'OpenCode 原生会话摘要')
})

test('会话标题会剔除注入上下文，只保留真实用户内容', () => {
  const result = preferUserSessionTitle({
    preview: '<environment_context>cwd=/tmp</environment_context> 继续处理 AgentLens 的性能问题',
  })
  assert.equal(result.title, '继续处理 AgentLens 的性能问题')
  assert.equal(result.preview, '继续处理 AgentLens 的性能问题')
})
