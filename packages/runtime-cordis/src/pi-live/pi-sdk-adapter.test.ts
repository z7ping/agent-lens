import assert from 'node:assert/strict'
import test from 'node:test'
import * as officialPiSdk from '@earendil-works/pi-coding-agent'
import {
  PI_SDK_TYPE_BASELINE,
  assertPiSdkModule,
  assertPiSdkSession,
  inspectPiSdkCompatibility,
  resolvePiSdkPackageUpdateApi,
  resolvePiSdkResourceApi,
} from './pi-sdk-adapter'

function fakeSession(): Record<string, unknown> {
  return {
    bindExtensions() {},
    subscribe() { return () => {} },
    setSessionName() {},
    setModel() {},
    setThinkingLevel() {},
    getAvailableThinkingLevels() { return ['off'] },
    prompt() {},
    steer() {},
    followUp() {},
    clearQueue() { return { steering: [], followUp: [] } },
    abort() {},
    dispose() {},
    sessionManager: {
      getSessionId() { return 'session' },
      getSessionFile() { return undefined },
      getSessionName() { return undefined },
      getLeafId() { return null },
      getEntries() { return [] },
    },
    modelRuntime: {
      getAvailableSnapshot() { return [] },
      getAvailable() { return Promise.resolve([]) },
    },
  }
}

test('0.84.x 使用 0.84.4 官方类型基线标记为已验证版本', () => {
  assert.equal(PI_SDK_TYPE_BASELINE, '0.84.4')
  assert.deepEqual(inspectPiSdkCompatibility('0.84.9'), {
    packageVersion: '0.84.9',
    typeBaseline: '0.84.4',
    testedVersion: true,
  })
  assert.equal(inspectPiSdkCompatibility('0.85.0').testedVersion, false)
  assert.equal(inspectPiSdkCompatibility(undefined).testedVersion, false)
})

test('0.84.4 官方 SDK 暴露结构化包更新检查能力', () => {
  const live = assertPiSdkModule(officialPiSdk, '/pi/dist/index.js', PI_SDK_TYPE_BASELINE)
  const updates = resolvePiSdkPackageUpdateApi(live)
  assert.ok(updates)
  assert.equal(typeof updates.getAgentDir, 'function')
  assert.equal(typeof updates.DefaultPackageManager, 'function')
  assert.equal(typeof updates.DefaultPackageManager.prototype.checkForAvailableUpdates, 'function')
})

test('0.84.4 官方 SDK 暴露 Pi Source P0/P1 所需纯资源解析能力', () => {
  const live = assertPiSdkModule(officialPiSdk, '/pi/dist/index.js', PI_SDK_TYPE_BASELINE)
  const resources = resolvePiSdkResourceApi(live)
  assert.ok(resources)
  assert.equal(typeof resources.SettingsManager.create, 'function')
  assert.equal(typeof resources.DefaultPackageManager, 'function')
  assert.equal(typeof resources.ProjectTrustStore, 'function')
  assert.equal(typeof resources.hasTrustRequiringProjectResources, 'function')
  assert.equal(typeof resources.loadSkills, 'function')
  assert.equal(typeof resources.loadSkillsFromDir, 'function')
  assert.equal(typeof resources.loadProjectContextFiles, 'function')
  assert.equal(typeof resources.parseFrontmatter, 'function')
})

test('模块能力缺失时给出明确 capability 错误', () => {
  assert.throws(
    () => assertPiSdkModule({ createAgentSession() {}, SessionManager: { create() {} } }, '/pi/dist/index.js', '0.85.0'),
    /SessionManager\.open/,
  )
})

test('模块校验识别 class 上的 SessionManager 静态方法', () => {
  class SessionManager {
    static create() {}
    static open() {}
  }
  assert.doesNotThrow(() => assertPiSdkModule(
    { createAgentSession() {}, SessionManager },
    '/pi/dist/index.js',
    '0.84.4',
  ))
})

test('资源能力不完整时只关闭资源解析，不破坏 Pi Live SDK 契约', () => {
  class SessionManager {
    static create() {}
    static open() {}
  }
  const live = assertPiSdkModule({ createAgentSession() {}, SessionManager }, '/pi/dist/index.js', '0.84.4')
  assert.equal(resolvePiSdkResourceApi(live), null)
})

test('Session 能力完整时允许未验证 minor 版本继续运行', () => {
  assert.doesNotThrow(() => assertPiSdkSession(fakeSession(), '/pi/dist/index.js', '0.85.0'))
})

test('Session 缺少 AgentLens 实际依赖能力时拒绝启动', () => {
  const session = fakeSession()
  delete session.followUp
  assert.throws(
    () => assertPiSdkSession(session, '/pi/dist/index.js', '0.84.4'),
    /followUp/,
  )
})
