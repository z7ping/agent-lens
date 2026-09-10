import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectDirectoryPicker } from './project-directory-picker.js'

test('目录选择器在同一次系统选择期间复用请求，并在结束后允许重试', async () => {
  let resolveSelection: ((value: string | undefined) => void) | undefined
  let calls = 0
  const picker = createProjectDirectoryPicker(process.platform, async () => {
    calls += 1
    return await new Promise<string | undefined>(resolve => { resolveSelection = resolve })
  }, 'foreground')

  const first = picker.select()
  const second = picker.select()
  assert.equal(calls, 1)
  resolveSelection?.('F:\\workspace')
  assert.equal(await first, 'F:\\workspace')
  assert.equal(await second, 'F:\\workspace')

  const third = picker.select()
  assert.equal(calls, 2)
  resolveSelection?.(undefined)
  assert.equal(await third, undefined)
})

test('目录选择失败后不会永久占用后续请求', async () => {
  let calls = 0
  const picker = createProjectDirectoryPicker(process.platform, async () => {
    calls += 1
    if (calls === 1) throw new Error('系统选择器不可用')
    return 'F:\\workspace'
  }, 'foreground')

  await assert.rejects(picker.select(), /系统选择器不可用/)
  assert.equal(await picker.select(), 'F:\\workspace')
  assert.equal(calls, 2)
})

test('managed Daemon 永远不直接拉起系统目录选择器', async () => {
  let calls = 0
  const picker = createProjectDirectoryPicker('win32', async () => {
    calls += 1
    return 'F:\\workspace'
  }, 'managed')

  assert.equal(await picker.select(), undefined)
  assert.equal(await picker.select(), undefined)
  assert.equal(calls, 0)
})
