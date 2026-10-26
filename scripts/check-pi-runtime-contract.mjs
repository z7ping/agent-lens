import { readFile } from 'node:fs/promises'

const [
  piNative,
  runtime,
  workerHost,
  workerEntry,
  inProcessHost,
  sdkLoader,
  sdkAdapter,
  runtimePackage,
  coreObservation,
  timelineProtocol,
  piAdapter,
  nativeHistory,
  slimLive,
  recoveryStore,
] = await Promise.all([
  readFile(new URL('../packages/protocol/src/pi-native.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-entry.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/in-process-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/sdk-loader.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/pi-sdk-adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../packages/core/src/domain/observation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/timeline.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/daemon/src/slim-pi-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/daemon/src/slim-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/recovery-store.ts', import.meta.url), 'utf8'),
])

const failures = []
const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) failures.push(label)
}
const forbidText = (source, pattern, label) => {
  if (pattern.test(source)) failures.push(label)
}

/* Pi-specific Live adapter capabilities belong here, not in the product-level Live gate. */
for (const capability of ['create', 'resume', 'fork', 'send', 'stream', 'interrupt', 'queue', 'steer', 'model-switching', 'thinking-control', 'extension-ui', 'recovery']) {
  requireText(piAdapter, new RegExp(`['"]${capability}['"]`), `Pi Live Adapter capability 缺少：${capability}`)
}
requireText(piAdapter, /liveId:\s*'pi'/, 'Pi Live Adapter 必须保持 liveId=pi')
requireText(piAdapter, /productId:\s*'pi'/, 'Pi Live Adapter 必须保持 productId=pi')
requireText(piAdapter, /image:\s*'native'/, 'Pi Live Adapter 必须显式声明原生图片能力')
requireText(piAdapter, /file:\s*'unsupported'/, 'Pi Live Adapter 不得伪装文件输入能力')
requireText(piAdapter, /workspace:\s*'required'/, 'Pi Live start workspace 必须保持 required')
requireText(piAdapter, /title:\s*'optional'/, 'Pi Live start title 必须保持 optional')
requireText(piAdapter, /this\.options\.nativeHistory\.resolve\(logicalSessionId, 'continue'\)/, 'Pi Adapter resume 必须走原生历史恢复')
requireText(piAdapter, /this\.options\.nativeHistory\.resolve\(logicalSessionId, 'fork'\)/, 'Pi Adapter fork 必须走原生历史分叉')
requireText(piAdapter, /this\.attachments\.get\(part\.attachmentId\)/, 'Pi Adapter 必须通过 opaque attachmentId 读取图片')
requireText(piAdapter, /Buffer\.from\(attachment\.data\)\.toString\('base64'\)/, 'Pi Adapter 必须在适配边界转换官方图片载荷')
requireText(piAdapter, /this\.service\.steer\(runtimeSessionId, resolved\.text, resolved\.images\)/, 'Pi steer 必须通过 Adapter 转入 Runtime')
requireText(piAdapter, /this\.service\.followUp\(runtimeSessionId, resolved\.text, resolved\.images\)/, 'Pi follow-up 必须通过 Adapter 转入 Runtime')

/* Historical facts and native Pi entries stay normalized at the Pi boundary. */
requireText(piNative, /type === 'model_change'/, 'Pi Native Normalizer 缺少 model_change')
requireText(piNative, /type === 'thinking_level_change'/, 'Pi Native Normalizer 缺少 thinking_level_change')
requireText(piNative, /role === 'tool' \|\| role === 'toolResult'/, 'Pi Native Normalizer 缺少 Tool Result')
requireText(coreObservation, /'thinking\.level\.changed'/, 'Core 缺少 thinking.level.changed')
requireText(timelineProtocol, /'thinking\.level\.changed'/, 'Timeline 缺少 thinking.level.changed')

/* Native Pi history uses verified Catalog identity and original JSONL. */
requireText(slimLive, /createSlimPiHistoryResolver\(catalog,reader,policy\)/, 'Pi Live 必须使用原生历史解析器')
requireText(nativeHistory, /reader\.read\(/, 'Pi 原生历史恢复必须先通过 Source Reader 校验')
requireText(nativeHistory, /file\.stat\(\)/, 'Pi 原生历史恢复必须复核文件身份')
requireText(nativeHistory, /data\.type!=='session'\|\|data\.id!==entry\.nativeSessionId/, 'Pi 原生历史恢复必须验证 JSONL 头身份')
forbidText(piAdapter, /resolvePiLiveHistoryInput|canonicalPiLiveSnapshot|\.repositories\.sourceRecords/, 'Pi Adapter 不得加载旧 SQL 历史')

/* Runtime lifecycle and ownership. */
requireText(runtime, /async list\(\): Promise<PiLiveRuntimeState\[]>/, 'Pi Runtime Service 必须提供活跃任务列举')
requireText(runtime, /status:\s*'initializing'/, 'Pi Runtime Start 必须先返回 initializing')
requireText(runtime, /runtime\.initialization\.abort\(\)/, 'initializing Terminate 必须取消 Worker 初始化')
requireText(runtime, /if \(input\.sessionPath && input\.historyAction !== 'fork'\)[\s\S]{0,1200}if \(duplicate\) return this\.state\(duplicate\.id\)/, '同一原生 Pi 会话必须幂等复用 Runtime')
requireText(runtime, /async abort\(id: string, options: \{ restoreQueue\?: boolean \} = \{\}\)/, 'Pi Runtime abort 必须支持队列恢复语义')
requireText(runtime, /runtime\.status = 'terminated'/, 'Pi Runtime terminate 必须落明确终态')
requireText(recoveryStore, /taskSummary\?:\s*string/, 'Pi Recovery Record 必须保留自动任务标题')
requireText(recoveryStore, /taskSummary = optionalString\(item\.taskSummary\)\?\.slice\(0, 240\)/, 'Pi Recovery 读取必须限制自动任务标题长度')
requireText(runtime, /\.\.\.\(runtime\.taskSummary \? \{ taskSummary: runtime\.taskSummary \} : \{\}\)/, 'Pi Runtime checkpoint 必须写入自动任务标题')
requireText(runtime, /runtime\.taskSummary = item\.taskSummary/, 'Pi Runtime 恢复必须还原自动任务标题')
requireText(runtime, /persistRuntimeMetadataBestEffort\(runtime\)/, '首条任务摘要生成后必须刷新 Recovery metadata checkpoint')
requireText(runtime, /runtime\.taskSummary \|\| runtime\.input\.name\?\.trim\(\)/, 'Pi 自动任务摘要不得覆盖用户显式标题')

/* Official SDK ownership stays in a worker boundary. */
requireText(workerHost, /from 'node:child_process'/, 'Pi SDK 必须由独立 Worker 承载')
requireText(workerHost, /return fork\(this\.workerEntry\(\), \[\], forkOptions\)/, 'Pi SDK Worker 必须通过独立子进程创建')
requireText(workerHost, /MAX_PENDING_REQUESTS/, 'Pi Worker IPC 待处理请求必须有界')
requireText(workerEntry, /const queue = value\.restoreQueue === false[\s\S]{0,220}session\.clearQueue\(\)/, 'Pi Abort 必须支持队列取回')
requireText(workerEntry, /session\.bindExtensions\(/, 'Pi Worker 必须通过官方 AgentSession 绑定 Extension Runtime')
requireText(workerEntry, /session\.getAllTools\(\)/, 'Pi 工具来源必须来自当前 AgentSession 原生注册表')
requireText(workerEntry, /source\.path === 'builtin:mcp'/, 'Pi MCP 身份必须以官方内置扩展注册来源为证据')
requireText(workerEntry, /toolRegistration:\s*\{\s*registry:\s*'pi\.AgentSession\.getAllTools'/, 'Pi Live 必须保留可追溯注册证据')
requireText(workerEntry, /resourceLoaderOptions:\s*\{\s*extensionFactories:\s*piBuiltinToolExtensionFactories\(loadedSdk\)/, 'Pi SDK 1.2 创建 SessionServices 时必须显式接入内置工具扩展')
requireText(workerEntry, /name:\s*'mcp'[\s\S]{0,160}replaceable:\s*true,\s*builtin:\s*true/, 'Pi 内置 MCP 扩展必须允许被用户已有扩展替代')
requireText(workerEntry, /sdk\.SessionManager\.open\(input\.sessionPath, sessionDir, input\.cwd\)/, 'Pi Worker 必须通过官方 SessionManager.open 恢复历史会话')
requireText(inProcessHost, /assertPiSdkSession\(created\.session, installed\.sdkEntry, installed\.version\)/, 'Pi SDK 契约夹具必须校验 AgentSession capability')
requireText(workerEntry, /extensionUi\.respond\(value\.requestId, value\.response\)/, 'Pi Extension UI 必须关联 Worker request id')

requireText(sdkAdapter, /from '@earendil-works\/pi-coding-agent'/, 'Pi SDK Adapter 必须从官方包派生类型')

requireText(sdkAdapter, /type PiSdkModel = Pick<OfficialPiModel/, 'Pi SDK Adapter 只暴露所需官方类型能力')
requireText(sdkAdapter, /export function assertPiSdkModule/, 'Pi SDK Adapter 缺少 Module capability 校验')
requireText(sdkAdapter, /export function assertPiSdkSession/, 'Pi SDK Adapter 缺少 Session capability 校验')
requireText(sdkAdapter, /export function asPiSdkExtensionUiContext/, 'Pi SDK Adapter 缺少 Extension UI capability 校验')
// Package manifest owns the exact compile-time SDK; the adapter must declare the
// same type baseline and tested minor. Never hardcode a prior SDK version here.
const declaredPiSdkVersion = JSON.parse(runtimePackage).devDependencies?.['@earendil-works/pi-coding-agent']
const adapterTypeBaseline = sdkAdapter.match(/export const PI_SDK_TYPE_BASELINE\s*=\s*'([^']+)'/)?.[1]
const adapterTestedMinor = sdkAdapter.match(/export const PI_SDK_TESTED_MINOR\s*=\s*'([^']+)'/)?.[1]
if (typeof declaredPiSdkVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(declaredPiSdkVersion)) {
  failures.push('runtime-cordis 必须精确固定官方 Pi SDK 版本，禁止范围/浮动依赖')
} else {
  if (adapterTypeBaseline !== declaredPiSdkVersion) {
    failures.push(`Pi SDK 类型基线与 runtime-cordis 依赖不一致：${adapterTypeBaseline ?? '未声明'} != ${declaredPiSdkVersion}`)
  }
  const expectedMinor = declaredPiSdkVersion.match(/^(\d+\.\d+)\./)?.[1]
  if (adapterTestedMinor !== expectedMinor) {
    failures.push(`Pi SDK 已验证 minor 与依赖不一致：${adapterTestedMinor ?? '未声明'} != ${expectedMinor}`)
  }
}
requireText(sdkLoader, /PI_SDK_PACKAGE_NAME/, 'Pi SDK Loader 必须只定位官方 Pi npm 包')
requireText(workerHost, /discoverInstalledPiSdk\(input\.executable\)/, 'Pi Worker Host 必须统一发现并验证官方 Pi SDK')
requireText(workerHost, /sdkEntry:\s*sdk\.sdkEntry/, 'Pi Worker Host 必须把验证后的 SDK 入口传给 Worker')
requireText(workerEntry, /await import\(pathToFileURL\(sdkEntry\)\.href\)/, 'Pi Worker 必须加载宿主已验证的官方 SDK')
requireText(workerEntry, /images:\s*value\.images/, 'Pi Worker 必须把图片送入官方 Session prompt')
requireText(sdkAdapter, /Pick<PromptOptions, 'images' \| 'streamingBehavior' \| 'source' \| 'preflightResult'>/, 'Pi SDK 图片/流式类型边界必须来自官方 PromptOptions')
forbidText(workerEntry, /function\s+(?:findExecutable|shimEntry|sdkEntryFor)\b/, 'Pi Worker 不得重复维护 PATH/npm shim 发现逻辑')
requireText(sdkLoader, /assertPiSdkModule\(imported, discovery\.sdkEntry, discovery\.version\)/, 'Pi SDK Loader 必须执行 Module capability 校验')
forbidText(sdkLoader, /export interface PiSdk(?:Session|Module|Model)/, 'Pi SDK Loader 不得维护手写 SDK 接口镜像')
forbidText(`${runtime}\n${sdkLoader}`, /PiRpcClient|--mode['"\s,]+rpc|child_process/, 'Pi Runtime 不得重新引入自维护 RPC 子进程协议')

if (failures.length) {
  console.error('Pi Runtime 原生契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Pi Runtime 原生契约检查通过：Adapter capability、原生历史恢复、独立 SDK Worker、官方类型边界与图片转换均已锁定。')
