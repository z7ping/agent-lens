import assert from 'node:assert/strict'
import { compareSemver as compareDesktopSemver, fetchAvailableUpdate } from '../../apps/desktop/src/update-check.mjs'
import { fetchAvailableNpmUpdate } from '../../apps/cli/src/update'
import { checkWebUpdate, type WebUpdateState } from '../../packages/web/src/client/update'

const baseline = process.env.AGENT_LENS_UPDATE_ACCEPTANCE_BASELINE || '1.0.0-alpha.1'

function memoryStorage(initial: WebUpdateState = {}) {
  let value = JSON.stringify(initial)
  return {
    getItem() { return value },
    setItem(_key: string, next: string) { value = next },
    state() { return JSON.parse(value) as WebUpdateState },
  }
}

async function retry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750))
    }
  }
  throw new Error(`${label} 连续 3 次失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const desktop = await retry('GitHub Release 在线检查', () => fetchAvailableUpdate(baseline, {
  platform: 'win32',
  arch: 'x64',
  signal: AbortSignal.timeout(10_000),
}))
assert.ok(desktop, `基线 ${baseline} 应能发现真实 GitHub Release 更新`)
assert.ok(compareDesktopSemver(desktop.version, baseline) > 0, `Desktop 最新版本 ${desktop.version} 必须高于 ${baseline}`)
assert.match(desktop.releasePageUrl, /^https:\/\/github\.com\/z7ping\/agent-lens\/releases\/tag\/v/)
assert.match(desktop.downloadUrl, /AgentLens-.*-Setup-x64\.exe$/i, '真实 Release 必须提供 Windows x64 Installer')
assert.ok(desktop.publishedAt, '真实 Release 必须包含发布时间')

const cli = await retry('npm Registry CLI 在线检查', () => fetchAvailableNpmUpdate(baseline, {
  signal: AbortSignal.timeout(10_000),
}))
assert.equal(cli.updateAvailable, true, `CLI 基线 ${baseline} 应能发现 npm 更新`)
assert.ok(cli.latestVersion !== baseline)
assert.equal(cli.installSpec, `@z7ping/agent-lens@${cli.latestVersion}`)

const storage = memoryStorage()
let networkCalls = 0
const trackedFetch: typeof fetch = async (input, init) => {
  networkCalls += 1
  return fetch(input, init)
}
const web = await retry('Web npm/GitHub 在线检查', () => checkWebUpdate(baseline, {
  runtimeOwner: 'service',
  force: true,
  storage,
  fetchImpl: trackedFetch,
}))
assert.ok(web, `Web service Runtime 基线 ${baseline} 应显示更新`)
assert.equal(web.latestVersion, cli.latestVersion, 'Web 与 CLI 必须选择同一个 npm 最新版本')
assert.equal(web.installCommand, 'agent-lens update')
assert.match(web.releasePageUrl, /^https:\/\/github\.com\/z7ping\/agent-lens\/releases\/tag\/v/)
assert.ok(networkCalls >= 1)

const callsAfterFirstCheck = networkCalls
const cached = await checkWebUpdate(baseline, {
  runtimeOwner: 'service',
  now: Date.now() + 60_000,
  storage,
  fetchImpl: trackedFetch,
})
assert.equal(cached?.latestVersion, web.latestVersion)
assert.equal(networkCalls, callsAfterFirstCheck, '24 小时缓存窗口内不得重复访问 npm/GitHub')

let desktopWebFetches = 0
const desktopWeb = await checkWebUpdate(baseline, {
  runtimeOwner: 'desktop',
  force: true,
  storage: memoryStorage(),
  fetchImpl: (async () => {
    desktopWebFetches += 1
    throw new Error('Desktop Runtime 不应执行 Web npm 更新检查')
  }) as typeof fetch,
})
assert.equal(desktopWeb, null)
assert.equal(desktopWebFetches, 0, 'Desktop Runtime 必须在任何网络请求前去重')

console.log(JSON.stringify({
  ok: true,
  baseline,
  desktop: {
    version: desktop.version,
    releasePageUrl: desktop.releasePageUrl,
    downloadUrl: desktop.downloadUrl,
  },
  npm: {
    latestVersion: cli.latestVersion,
    installSpec: cli.installSpec,
  },
  web: {
    latestVersion: web.latestVersion,
    releasePageUrl: web.releasePageUrl,
    networkCalls,
    cacheNetworkCalls: networkCalls - callsAfterFirstCheck,
    desktopWebFetches,
  },
}, null, 2))
