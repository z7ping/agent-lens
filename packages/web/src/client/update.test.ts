import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkWebUpdate,
  compareSemver,
  selectUpdateVersion,
  shouldCheckForUpdate,
  shouldCheckWebUpdateForRuntimeOwner,
  type WebUpdateState,
} from './update'

function memoryStorage(initial: WebUpdateState = {}) {
  let value = JSON.stringify(initial)
  return {
    getItem() { return value },
    setItem(_key: string, next: string) { value = next },
    state() { return JSON.parse(value) as WebUpdateState },
  }
}

test('Web 更新遵循 alpha beta rc stable 语义顺序', () => {
  assert.ok(compareSemver('1.0.0-beta.0', '1.0.0-alpha.9') > 0)
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0-beta.9') > 0)
  assert.ok(compareSemver('1.0.0', '1.0.0-rc.9') > 0)
})

test('Stable 只选择 Stable，预发布可进入后续预发布或 Stable', () => {
  const metadata = { versions: {
    '1.0.0': {},
    '1.0.1-alpha.1': {},
    '1.0.1-beta.1': {},
    '1.0.1': {},
  } }
  assert.equal(selectUpdateVersion(metadata, '1.0.0'), '1.0.1')
  assert.equal(selectUpdateVersion(metadata, '1.0.0-alpha.1'), '1.0.1')
})

test('Web 自动检查按 24 小时节流', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z')
  assert.equal(shouldCheckForUpdate(undefined, now), true)
  assert.equal(shouldCheckForUpdate('2026-08-30T11:00:00.000Z', now), false)
  assert.equal(shouldCheckForUpdate('2026-08-29T11:59:59.000Z', now), true)
})

test('Desktop runtime 不重复执行 Web npm 更新提醒', () => {
  assert.equal(shouldCheckWebUpdateForRuntimeOwner('desktop'), false)
  assert.equal(shouldCheckWebUpdateForRuntimeOwner('service'), true)
  assert.equal(shouldCheckWebUpdateForRuntimeOwner('cli'), true)
  assert.equal(shouldCheckWebUpdateForRuntimeOwner(null), true)
})

test('24 小时内直接复用已缓存的新版本，不再次请求网络', async () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z')
  const storage = memoryStorage({
    lastCheckedAt: new Date(now - 60_000).toISOString(),
    availableVersion: '1.0.1',
    releasePageUrl: 'https://example.test/releases/v1.0.1',
  })
  let fetchCount = 0
  const result = await checkWebUpdate('1.0.0', {
    runtimeOwner: 'service',
    now,
    storage,
    fetchImpl: (async () => {
      fetchCount += 1
      throw new Error('不应请求网络')
    }) as typeof fetch,
  })
  assert.equal(fetchCount, 0)
  assert.equal(result?.latestVersion, '1.0.1')
  assert.equal(result?.installCommand, 'agent-lens update')
})

test('网络失败只刷新检查时间，不影响缓存更新提示', async () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z')
  const storage = memoryStorage({
    lastCheckedAt: '2026-08-29T00:00:00.000Z',
    availableVersion: '1.0.1',
  })
  const result = await checkWebUpdate('1.0.0', {
    runtimeOwner: 'service',
    now,
    storage,
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch,
  })
  assert.equal(result?.latestVersion, '1.0.1')
  assert.equal(storage.state().lastCheckedAt, new Date(now).toISOString())
})
