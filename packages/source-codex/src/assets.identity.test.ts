import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { codexAssetInternals } from './assets'

test('Codex 同名 Skill 按真实目录保持独立身份', () => {
  const left = codexAssetInternals.codexSkillIdentity(join('/tmp', 'codex-home', 'skills', 'team-a', 'review-helper'))
  const right = codexAssetInternals.codexSkillIdentity(join('/tmp', 'codex-home', 'skills', 'team-b', 'review-helper'))

  assert.notEqual(left, right)
  assert.match(left.replaceAll('\\', '/'), /team-a\/review-helper$/i)
  assert.match(right.replaceAll('\\', '/'), /team-b\/review-helper$/i)
})
