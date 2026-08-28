import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReleaseVersion, validateRequestedVersion } from './resolve-release-version.mjs'

test('auto 会递增已有预发布序号', () => {
  assert.equal(resolveReleaseVersion('1.0.0-alpha.1'), '1.0.0-alpha.2')
  assert.equal(resolveReleaseVersion('1.0.0-rc'), '1.0.0-rc.1')
})

test('auto 会为正式版递增 patch', () => {
  assert.equal(resolveReleaseVersion('1.2.3'), '1.2.4')
})

test('可以显式选择正式版、patch、minor 或 major', () => {
  assert.equal(resolveReleaseVersion('1.2.3-rc.2', 'stable'), '1.2.3')
  assert.equal(resolveReleaseVersion('1.2.3-rc.2', 'patch'), '1.2.4')
  assert.equal(resolveReleaseVersion('1.2.3-rc.2', 'minor'), '1.3.0')
  assert.equal(resolveReleaseVersion('1.2.3-rc.2', 'major'), '2.0.0')
})

test('拒绝无法成立的正式版转换', () => {
  assert.throws(() => resolveReleaseVersion('1.2.3', 'stable'), /已经是正式版/)
})

test('显式版本允许当前已准备版本，但拒绝降级和非法 SemVer', () => {
  assert.equal(validateRequestedVersion('1.0.0-alpha.2', '1.0.0-alpha.2'), '1.0.0-alpha.2')
  assert.equal(validateRequestedVersion('1.0.0-alpha.2', '1.0.0-beta.1'), '1.0.0-beta.1')
  assert.throws(() => validateRequestedVersion('1.0.0-alpha.2', '1.0.0-alpha.1'), /不能低于/)
  assert.throws(() => validateRequestedVersion('1.0.0', '01.0.1'), /合法 SemVer/)
})
