import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { readHostProjectDirectory } from './project-directory-host'

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage
}

test('没有宿主标记时继续使用运行时目录选择器', () => {
  assert.deepEqual(readHostProjectDirectory(request({})), { handled: false })
})

test('Desktop 取消目录选择时由宿主完成请求并返回空目录', () => {
  assert.deepEqual(readHostProjectDirectory(request({
    'x-agent-lens-host-picker': 'project-directory',
  })), { handled: true })
})

test('Desktop 目录通过请求元数据无损传入 HTTP Surface', () => {
  const cwd = 'C:\\工作区\\Agent Lens'
  assert.deepEqual(readHostProjectDirectory(request({
    'x-agent-lens-host-picker': 'project-directory',
    'x-agent-lens-host-project-directory': encodeURIComponent(cwd),
  })), { handled: true, cwd })
})

test('无效宿主目录编码返回 400 而不是回退到后台目录选择器', () => {
  assert.throws(
    () => readHostProjectDirectory(request({
      'x-agent-lens-host-picker': 'project-directory',
      'x-agent-lens-host-project-directory': '%E0%A4%A',
    })),
    (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'statusCode') === 400),
  )
})
