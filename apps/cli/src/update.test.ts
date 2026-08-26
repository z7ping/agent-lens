import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSemver, npmInstallArgs, selectUpdateVersion, shouldCheckForUpdate } from './update.ts'

test('SemVer 按 alpha beta rc stable 顺序比较', () => {
  assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.0') > 0)
  assert.ok(compareSemver('1.0.0-beta.0', '1.0.0-alpha.9') > 0)
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0-beta.2') > 0)
  assert.ok(compareSemver('1.0.0', '1.0.0-rc.9') > 0)
})

test('正式版忽略更高的预发布版', () => {
  const result = selectUpdateVersion({ versions: {
    '1.0.1-alpha.0': {},
    '1.0.0': {},
    '1.0.1': {},
  } }, '1.0.0')
  assert.equal(result, '1.0.1')
})

test('预发布版可进入后续预发布或正式版', () => {
  const result = selectUpdateVersion({ versions: {
    '1.0.0-alpha.1': {},
    '1.0.0-beta.0': {},
    '1.0.0-rc.1': {},
    '1.0.0': {},
  } }, '1.0.0-alpha.0')
  assert.equal(result, '1.0.0')
})

test('忽略废弃版本和无效版本', () => {
  const result = selectUpdateVersion({ versions: {
    '1.0.1': { deprecated: 'bad' },
    latest: {},
    '1.0.0': {},
  } }, '1.0.0')
  assert.equal(result, null)
})

test('被动检查最多每 24 小时一次', () => {
  const now = Date.parse('2026-08-26T10:00:00.000Z')
  assert.equal(shouldCheckForUpdate(undefined, now), true)
  assert.equal(shouldCheckForUpdate('2026-08-26T09:00:00.000Z', now), false)
  assert.equal(shouldCheckForUpdate('2026-08-25T09:59:59.000Z', now), true)
})

test('升级安装固定到已选择的精确版本', () => {
  assert.deepEqual(npmInstallArgs('1.0.0-beta.1'), [
    'install', '--global', '@z7ping/agent-lens@1.0.0-beta.1',
  ])
})
