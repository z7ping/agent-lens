import assert from 'node:assert/strict'
import test from 'node:test'
import { localPathOpenCommand } from './local-path-opener.js'

test('Windows 文件使用 Explorer 定位，目录直接打开', () => {
  assert.deepEqual(
    localPathOpenCommand('win32', 'C:\\work\\AGENTS.md', 'file'),
    {
      command: 'explorer.exe',
      args: ['/select,C:\\work\\AGENTS.md'],
      action: 'revealed',
    },
  )
  assert.deepEqual(
    localPathOpenCommand('win32', 'C:\\work', 'directory'),
    {
      command: 'explorer.exe',
      args: ['C:\\work'],
      action: 'opened',
    },
  )
})

test('macOS 文件由 Finder 定位', () => {
  assert.deepEqual(
    localPathOpenCommand('darwin', '/Users/demo/AGENTS.md', 'file'),
    {
      command: 'open',
      args: ['-R', '/Users/demo/AGENTS.md'],
      action: 'revealed',
    },
  )
})

test('Linux 文件打开所在目录', () => {
  assert.deepEqual(
    localPathOpenCommand('linux', '/home/demo/work/AGENTS.md', 'file'),
    {
      command: 'xdg-open',
      args: ['/home/demo/work'],
      action: 'opened',
    },
  )
})

test('不支持的平台明确拒绝', () => {
  assert.throws(
    () => localPathOpenCommand('aix', '/tmp/file', 'file'),
    /不支持直接定位本地路径/,
  )
})
