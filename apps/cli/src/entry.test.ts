import assert from 'node:assert/strict'
import test from 'node:test'
import { cliEntryInternals } from './entry'

test('JSON 与长运行命令不追加被动更新提示', () => {
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['status', '--json'], 0), false)
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['start'], 0), false)
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['service', 'run'], 0), false)
})

test('普通成功命令允许追加被动更新提示', () => {
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['status'], 0), true)
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['doctor'], 0), true)
  assert.equal(cliEntryInternals.shouldOfferPassiveUpdate(['status'], 1), false)
})

test('update 命令兼容 --json 前后位置', () => {
  assert.deepEqual(cliEntryInternals.updateArgs(['update', '--check', '--json']), ['--check', '--json'])
  assert.deepEqual(cliEntryInternals.updateArgs(['--json', 'update', '--check']), ['--json', '--check'])
  assert.equal(cliEntryInternals.updateArgs(['status', '--json']), null)
})
