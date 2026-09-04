import fs from 'node:fs'

const model = fs.readFileSync('packages/web/src/client/model.ts', 'utf8')
const api = fs.readFileSync('packages/web/src/client/api.ts', 'utf8')
const reviewPage = fs.readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const hubReview = fs.readFileSync('packages/web/src/client/hub-review.ts', 'utf8')
const app = fs.readFileSync('packages/web/src/App.tsx', 'utf8')
const workspaceSidebar = fs.readFileSync('packages/web/src/components/WorkspaceSidebar.tsx', 'utf8')
const releaseInfo = fs.readFileSync('packages/web/src/components/ReleaseInfo.tsx', 'utf8')
const protocol = fs.readFileSync('packages/protocol/src/review.ts', 'utf8')
const server = fs.readFileSync('packages/surface-http/src/server.ts', 'utf8')

const required = [
  [model.includes('reviewInFlight'), 'Review 列表必须保持单飞请求'],
  [model.includes('reviewRequestDirty'), 'Review 列表必须保留 dirty 补刷语义'],
  [model.includes('scheduleReviewRefresh()'), 'SSE 必须通过调度器刷新列表'],
  [model.includes('meta.nextCursor'), '任务列表加载更多必须消费 nextCursor'],
  [!model.includes('current.limit + REVIEW_PAGE_SIZE'), '不得恢复累计 limit 假分页'],
  [model.includes('document.hidden') && model.includes('reviewLiveDirty'), '后台页签不得持续刷新 Review 列表'],
  [app.includes('model.ensureReview()'), 'Review 必须按路由加载'],
  [app.includes('model.ensureUsage()'), 'usage 必须按路由加载'],
  [app.includes('model.ensureAgents()'), 'agents 必须按路由加载'],
  [hubReview.includes('hubSessionInFlight'), 'Hub 列表请求必须由共享单飞层统一拥有'],
  [hubReview.includes('HUB_SESSION_CACHE_MS'), 'Hub 列表请求必须保留短缓存'],
  [api.includes("params.set('cursor', cursor)"), 'Review API 必须透传列表游标'],
  [protocol.includes('nextCursor?: string'), 'Review 列表协议必须返回 nextCursor'],
  [server.includes("params.get('cursor')"), 'HTTP Surface 必须解析 Review 列表游标'],
  [releaseInfo.includes('runtimeReady') && releaseInfo.includes('{ runtimeOwner }'), '版本检查必须复用已有 runtime health 结果'],
  [workspaceSidebar.includes('runtimeOwner={snapshot.health?.runtime?.owner ?? null}'), 'Shell 必须把已有 health 传给版本检查'],
  [!api.includes('preferUserSessionTitle'), 'Web API 不得用首条用户消息覆盖 Source/Core 提供的原生会话标题'],
  [
    reviewPage.includes('sessionTitle([item.title, item.preview]')
      && reviewPage.includes('[detail.title, detail.preview]')
      && reviewPage.includes('const taskDetailModel = useMemo<TaskDetailModel | null>'),
    '任务列表与 TaskDetailModel 详情投影必须统一使用“原生标题 → 首条用户消息 → 通用兜底”语义',
  ],
]

const failed = required.filter(([ok]) => !ok)
if (failed.length) {
  for (const [, message] of failed) console.error(`性能契约失败：${message}`)
  process.exit(1)
}
console.log('Task Center performance contract passed')