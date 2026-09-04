import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PI_SDK_TYPE_BASELINE,
  assertPiSdkModule,
  assertPiSdkSession,
  inspectPiSdkCompatibility,
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
