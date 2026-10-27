import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import test from 'node:test'
import { npmLocalTarballSpecifier } from './npm-local-tarball-specifier.mjs'

test('Windows DOS 8.3 temp path stays a literal relative npm file specifier', () => {
  const root = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\agent-lens-npm-smoke'
  const actual = npmLocalTarballSpecifier(
    win32.join(root, 'consumer'),
    win32.join(root, 'pack', 'z7ping-agent-lens-1.0.0-alpha.7.tgz'),
    win32.relative,
  )
  assert.equal(actual, 'file:../pack/z7ping-agent-lens-1.0.0-alpha.7.tgz')
  assert.doesNotMatch(actual, /%7E|\\/)
})

test('Windows spaces and Unicode paths do not become percent-encoded', () => {
  const root = 'C:\\Users\\张 三\\AppData\\Local\\Temp\\agent lens'
  assert.equal(
    npmLocalTarballSpecifier(win32.join(root, 'consumer'), win32.join(root, 'pack', '测试 包.tgz'), win32.relative),
    'file:../pack/测试 包.tgz',
  )
})

test('POSIX local package specifiers stay unchanged', () => {
  assert.equal(
    npmLocalTarballSpecifier('/tmp/agent-lens/consumer', '/tmp/agent-lens/pack/package.tgz', posix.relative),
    'file:../pack/package.tgz',
  )
})

test('actual package smoke installs the normalized local file specifier', () => {
  const smoke = readFileSync(new URL('./smoke-npm-package.mjs', import.meta.url), 'utf8')
  assert.match(smoke, /npmLocalTarballSpecifier\(consumer, tarball\)/)
  assert.match(smoke, /'install', '--no-audit', '--no-fund', localTarballSpecifier/)
})
