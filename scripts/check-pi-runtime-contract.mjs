import { readFile } from 'node:fs/promises'

const [
  history,
  piNative,
  piClient,
  piHttp,
  runtime,
  workerHost,
  workerEntry,
  inProcessHost,
  sdkLoader,
  sdkAdapter,
  runtimePackage,
  coreObservation,
  timelineProtocol,
  piLiveProtocol,
  resumeWrapper,
  historyInteraction,
  piAdapter,
  recoveryStore,
] = await Promise.all([
  readFile(new URL('../packages/web/src/features/pi-live-history.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/pi-native.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/web/src/client/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/worker-entry.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/in-process-host.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/sdk-loader.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/pi-sdk-adapter.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/package.json', import.meta.url), 'utf8'),
  readFile(new URL('../packages/core/src/domain/observation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/timeline.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/protocol/src/pi-live.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/surface-http/src/pi-live-resume.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/history-interaction.ts', import.meta.url), 'utf8'),
  readFile(new URL('../packages/runtime-cordis/src/pi-live/adapter.ts', import.meta.url), 'utf8'),
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
requireText(piAdapter, /resolvePiLiveHistoryInput\(this\.storage, logicalSessionId, 'continue'\)/, 'Pi Adapter resume 必须走受控历史恢复')
requireText(piAdapter, /resolvePiLiveHistoryInput\(this\.storage, logicalSessionId, 'fork'\)/, 'Pi Adapter fork 必须走受控历史分叉')
requireText(piAdapter, /this\.attachments\.get\(part\.attachmentId\)/, 'Pi Adapter 必须通过 opaque attachmentId 读取图片')
requireText(piAdapter, /Buffer\.from\(attachment\.data\)\.toString\('base64'\)/, 'Pi Adapter 必须在适配边界转换官方图片载荷')
requireText(piAdapter, /this\.service\.steer\(runtimeSessionId, resolved\.text, resolved\.images\)/, 'Pi steer 必须通过 Adapter 转入 Runtime')
requireText(piAdapter, /this\.service\.followUp\(runtimeSessionId, resolved\.text, resolved\.images\)/, 'Pi follow-up 必须通过 Adapter 转入 Runtime')

/* Historical facts and native Pi entries stay normalized at the Pi boundary. */
requireText(history, /normalizePiSessionEntry/, 'Pi 历史投影必须复用 Pi Native Normalizer')
requireText(piNative, /type === 'model_change'/, 'Pi Native Normalizer 缺少 model_change')
requireText(piNative, /type === 'thinking_level_change'/, 'Pi Native Normalizer 缺少 thinking_level_change')
requireText(piNative, /role === 'tool' \|\| role === 'toolResult'/, 'Pi Native Normalizer 缺少 Tool Result')
forbidText(history, /function\s+(?:messageItems|lifecycleItem|toolResultFacts)\b/, 'Web 不得重复维护 Pi Session Entry Parser')
requireText(coreObservation, /'thinking\.level\.changed'/, 'Core 缺少 thinking.level.changed')
requireText(timelineProtocol, /'thinking\.level\.changed'/, 'Timeline 缺少 thinking.level.changed')

/* Compatibility client remains server-owned: no local runtime registry. */
requireText(piClient, /requestJson<PiLiveStateDto\[]>\('\/api\/v1\/pi-live'\)/, 'Pi compatibility client 必须从服务端列举 Runtime')
forbidText(piClient, /readKnownRuntimeIds|agent-lens:pi-live-runtime-ids/, 'Pi Runtime registry 不得退回 localStorage')
requireText(piClient, /HIDDEN_FLUSH_MS = 250/, 'Pi compatibility scheduler 后台提交频率必须受控')
requireText(piClient, /requestAnimationFrame/, 'Pi compatibility scheduler 前台必须按动画帧提交')
requireText(piClient, /coalescedEvents/, 'Pi compatibility scheduler 必须保留事件合并诊断')
requireText(piClient, /source\.close\(\)/, '关闭 Pi View 必须只关闭 EventSource')
forbidText(piClient, /terminate\([^)]*\)[\s\S]{0,120}source\.close/, 'View dispose 不得隐式 terminate Pi Runtime')

/* Legacy Pi HTTP surface is compatibility-only but must remain safe while present. */
requireText(piLiveProtocol, /interface PiLiveResumeRequestDto[\s\S]{0,120}logicalSessionId:\s*string/, 'Pi compatibility protocol 缺少历史恢复请求')
requireText(piClient, /'\/api\/v1\/pi-live\/resume'[\s\S]{0,220}logicalSessionId/, 'Pi compatibility client 缺少历史恢复端点')
requireText(piHttp, /url\.pathname === '\/api\/v1\/pi-live'[\s\S]*request\.method === 'GET'[\s\S]*service\.list\(\)/, 'Pi compatibility HTTP 必须支持列举活跃 Runtime')
requireText(piHttp, /url\.pathname === '\/api\/v1\/pi-live\/resume'[\s\S]{0,600}resolvePiLiveResumeInput[\s\S]{0,220}service\.start\(input\)/, 'Pi compatibility HTTP 恢复必须走安全解析')
requireText(resumeWrapper, /return resolvePiLiveHistoryInput\(storage, logicalSessionId, historyAction\)/, 'Pi HTTP 兼容 wrapper 必须委托 Pi Integration 的历史恢复 Owner')
requireText(historyInteraction, /item\.sourceId === 'pi'/, 'Pi 历史恢复只能选择 Pi SourceRecord')
requireText(historyInteraction, /isAbsolute\(item\.locator\.path\)/, 'Pi 历史恢复只接受绝对原生路径')
requireText(historyInteraction, /extname\(item\.locator\.path\)\.toLowerCase\(\) === '\.jsonl'/, 'Pi 历史恢复只接受 JSONL 原生会话文件')
requireText(historyInteraction, /listSourceSessionsByLogicalSession[\s\S]{0,360}sourceId:\s*'pi'[\s\S]{0,120}limit:\s*MAX_RESUME_SOURCE_SESSIONS/, 'Pi 恢复解析器必须先用 sourceId + limit 有界定位 SourceSession')
requireText(historyInteraction, /sourceRecords\.findByNativeId\([\s\S]{0,180}'pi'[\s\S]{0,180}sourceSession\.nativeSessionId/, 'Pi 恢复解析器必须通过 native identity 精确读取 SourceRecord')
forbidText(historyInteraction, /observations\.query|repositories\.evidence|limit:\s*5_000/, 'Pi 恢复解析器不得恢复 Observation / Evidence 全时间线扫描')
requireText(historyInteraction, /await stat\(sessionPath\)/, 'Pi 恢复解析器必须验证原生文件存在')
requireText(historyInteraction, /await isMatchingPiSessionFile\(sessionPath, nativeSessionIds\)/, 'Pi 恢复解析器必须验证原生 JSONL 身份')
requireText(historyInteraction, /workspace\?\.path\?\.trim\(\) \|\| sourceRecordCwd\(sourceRecord\)/, 'Pi 恢复解析器必须恢复原工作目录')
requireText(piHttp, /request\.once\('close', cleanup\)/, 'Pi SSE 断开必须释放订阅')
requireText(piHttp, /service\.terminate\(runtimeSessionId\)/, 'Pi Runtime 只能显式 DELETE 终止')

/* Runtime lifecycle and ownership. */
requireText(runtime, /async list\(\): Promise<PiLiveRuntimeState\[]>/, 'Pi Runtime Service 必须提供活跃任务列举')
requireText(runtime, /status:\s*'initializing'/, 'Pi Runtime Start 必须先返回 initializing')
requireText(runtime, /runtime\.initialization\.abort\(\)/, 'initializing Terminate 必须取消 Worker 初始化')
requireText(runtime, /if \(input\.sessionPath && input\.historyAction !== 'fork'\)[\s\S]{0,760}if \(duplicate\) return this\.runtimeState\(duplicate\)/, '同一原生 Pi 会话必须幂等复用 Runtime')
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
requireText(workerEntry, /sdk\.SessionManager\.open\(input\.sessionPath, sessionDir, input\.cwd\)/, 'Pi Worker 必须通过官方 SessionManager.open 恢复历史会话')
requireText(inProcessHost, /assertPiSdkSession\(created\.session, installed\.sdkEntry, installed\.version\)/, 'Pi SDK 契约夹具必须校验 AgentSession capability')
requireText(workerEntry, /extensionUi\.respond\(value\.requestId, value\.response\)/, 'Pi Extension UI 必须关联 Worker request id')

requireText(sdkAdapter, /from '@earendil-works\/pi-coding-agent'/, 'Pi SDK Adapter 必须从官方包派生类型')
requireText(sdkAdapter, /PI_SDK_TYPE_BASELINE = '0\.84\.4'/, 'Pi SDK Adapter 必须记录 0.84.4 类型基线')
requireText(sdkAdapter, /type PiSdkModel = Pick<OfficialPiModel/, 'Pi SDK Adapter 只暴露所需官方类型能力')
requireText(sdkAdapter, /export function assertPiSdkModule/, 'Pi SDK Adapter 缺少 Module capability 校验')
requireText(sdkAdapter, /export function assertPiSdkSession/, 'Pi SDK Adapter 缺少 Session capability 校验')
requireText(sdkAdapter, /export function asPiSdkExtensionUiContext/, 'Pi SDK Adapter 缺少 Extension UI capability 校验')
requireText(runtimePackage, /"@earendil-works\/pi-coding-agent":\s*"0\.84\.4"/, 'runtime-cordis 必须以官方 Pi SDK 0.84.4 为类型基线')
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
  console.error('Pi Runtime / 兼容层契约检查失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Pi Runtime / 兼容层契约检查通过：Adapter capability、历史恢复、服务端所有权、独立 SDK Worker、官方类型边界、图片转换与兼容 HTTP 均已锁定。')
