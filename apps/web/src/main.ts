import {
  AGENT_LENS_PROTOCOL_VERSION,
  TIMELINE_OBSERVATION_KINDS,
  type JsonValue,
  type SessionDetailDto,
  type TimelineCaptureMethod,
  type TimelineConfidence,
  type TimelineDerivation,
  type TimelineItemDto,
  type TimelineObservationKind,
  type TimelineQueryDto,
  type ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { getHealth, getSessions, getTimeline, getUsage, subscribeUpdates } from './api'
import './styles.css'

type ViewId = 'timeline' | 'sessions' | 'usage'
type TimelineRenderState = { node: HTMLElement; snapshot: string }

type SummaryField = { label: string; value: string }

const KIND_LABELS: Record<TimelineObservationKind, string> = {
  'session.lifecycle': '会话状态',
  'message.user': '用户消息',
  'message.assistant': 'Agent 回复',
  'message.reasoning': '推理记录',
  'model.call': '模型调用',
  'model.changed': '模型切换',
  'tool.call': '工具调用',
  'tool.progress': '工具进度',
  'tool.result': '工具结果',
  'permission.request': '权限请求',
  'permission.response': '权限响应',
  'subagent.spawn': '子 Agent 启动',
  'subagent.end': '子 Agent 结束',
  'context.compaction': '上下文压缩',
  'context.summary': '上下文摘要',
  'artifact.action': '产物操作',
  usage: '用量',
  unknown: '其他事件',
}

const CAPTURE_LABELS: Record<TimelineCaptureMethod, string> = {
  'runtime-hook': '实时 Hook',
  'native-log': '原生日志',
  'native-db': '原生数据库',
  'static-scan': '静态扫描',
  'external-import': '外部导入',
}

const DERIVATION_LABELS: Record<TimelineDerivation, string> = {
  observed: '直接观察',
  reported: '来源报告',
  derived: '派生',
  estimated: '估算',
  inferred: '推断',
}

const CONFIDENCE_LABELS: Record<TimelineConfidence, string> = {
  exact: '精确',
  high: '高',
  medium: '中',
  low: '低',
  unknown: '未知',
}

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('未找到 AgentLens 页面挂载节点')

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function valueText(value: JsonValue, maxLength = 360): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (value === null) text = 'null'
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  else text = JSON.stringify(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function humanKey(key: string): string {
  const known: Record<string, string> = {
    text: '内容', content: '内容', message: '消息', summary: '摘要',
    tool: '工具', toolName: '工具', name: '名称', command: '命令',
    model: '模型', status: '状态', result: '结果', error: '错误',
    reason: '原因', cwd: '工作目录', path: '路径', durationMs: '耗时',
  }
  return known[key] ?? key
}

function summarizePayload(payload: JsonValue): SummaryField[] {
  if (!isRecord(payload)) return [{ label: '内容', value: valueText(payload) }]

  const priority = [
    'text', 'content', 'message', 'summary', 'toolName', 'tool', 'name', 'command',
    'model', 'status', 'result', 'error', 'reason', 'cwd', 'path', 'durationMs',
  ]
  const ignored = new Set([
    'id', 'sessionId', 'session_id', 'installationId', 'sourceSessionId',
    'logicalSessionId', 'timestamp', 'ts', 'uuid', 'callId', 'call_id',
  ])
  const picked: SummaryField[] = []
  const seen = new Set<string>()

  for (const key of priority) {
    const value = payload[key]
    if (value === undefined || seen.has(key)) continue
    picked.push({ label: humanKey(key), value: valueText(value) })
    seen.add(key)
    if (picked.length >= 4) return picked
  }

  for (const [key, value] of Object.entries(payload)) {
    if (seen.has(key) || ignored.has(key)) continue
    if (typeof value === 'object' && value !== null && picked.length >= 2) continue
    picked.push({ label: humanKey(key), value: valueText(value) })
    if (picked.length >= 4) break
  }

  return picked.length ? picked : [{ label: '原始数据', value: JSON.stringify(payload) }]
}

function formatTime(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(time)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

function sourceName(sourceId: string): string {
  const known: Record<string, string> = {
    codex: 'Codex', 'claude-code': 'Claude Code', pi: 'Pi',
  }
  return known[sourceId] ?? sourceId
}

const shell = element('div', 'shell')
const header = element('header', 'topbar')
const brand = element('div', 'brand')
brand.append(element('div', 'brand-mark', 'AL'), element('div', 'brand-copy'))
brand.querySelector('.brand-copy')!.append(
  element('strong', '', 'AgentLens'),
  element('span', '', `本地 Agent 执行轨迹 · Protocol ${AGENT_LENS_PROTOCOL_VERSION}`),
)

const headerActions = element('div', 'header-actions')
const healthBadge = element('div', 'health-badge health-loading', '正在检查 Daemon…')
const refreshButton = element('button', 'refresh-button', '刷新')
refreshButton.type = 'button'
headerActions.append(healthBadge, refreshButton)
header.append(brand, headerActions)

const nav = element('nav', 'view-nav')
const viewButtons = new Map<ViewId, HTMLButtonElement>()
for (const [id, label, hint] of [
  ['timeline', '执行轨迹', '逐条查看 Agent 实际发生了什么'],
  ['sessions', '会话', '按任务 / 会话聚合执行过程'],
  ['usage', '工具与能力', '查看工具和可归因能力的实际使用'],
] as const) {
  const button = element('button', 'view-tab')
  button.type = 'button'
  button.dataset.view = id
  button.append(element('strong', '', label), element('span', '', hint))
  nav.append(button)
  viewButtons.set(id, button)
}

const filters = element('details', 'filters')
const filterSummary = element('summary', 'filters-summary', '筛选条件')
const filterGrid = element('div', 'filter-grid')

function labeledControl(label: string, control: HTMLElement): HTMLElement {
  const wrap = element('label', 'field')
  wrap.append(element('span', 'field-label', label), control)
  return wrap
}

const kindSelect = element('select', 'control')
kindSelect.append(new Option('全部事件类型', ''))
for (const kind of TIMELINE_OBSERVATION_KINDS) kindSelect.append(new Option(KIND_LABELS[kind], kind))
const kindField = labeledControl('事件类型', kindSelect)

const installationInput = element('input', 'control')
installationInput.placeholder = '留空表示全部安装实例'
const sessionInput = element('input', 'control')
sessionInput.placeholder = '留空表示全部会话'
const limitSelect = element('select', 'control')
for (const limit of [50, 100, 200, 500]) limitSelect.append(new Option(`最近 ${limit} 条`, String(limit)))
limitSelect.value = '100'

const applyFiltersButton = element('button', 'secondary-button', '应用筛选')
applyFiltersButton.type = 'button'
const clearFiltersButton = element('button', 'ghost-button', '清空')
clearFiltersButton.type = 'button'
const filterActions = element('div', 'filter-actions')
filterActions.append(applyFiltersButton, clearFiltersButton)
filterGrid.append(
  kindField,
  labeledControl('安装实例 ID', installationInput),
  labeledControl('逻辑会话 ID', sessionInput),
  labeledControl('返回数量', limitSelect),
  filterActions,
)
filters.append(filterSummary, filterGrid)

const summary = element('section', 'summary-row')
const countText = element('span', 'summary-count', '尚未加载数据')
const noticeText = element('span', 'summary-note', '')
summary.append(countText, noticeText)
const errorBox = element('div', 'error-box')
errorBox.hidden = true
const content = element('section', 'content')
shell.append(header, nav, filters, summary, errorBox, content)
root.replaceChildren(shell)

let currentView: ViewId = 'timeline'
let liveUpdateTimer: number | undefined
let refreshGeneration = 0
let timelineState = new Map<string, TimelineRenderState>()
let pendingLiveData = false

function scopedQuery() {
  const installationId = installationInput.value.trim()
  const logicalSessionId = sessionInput.value.trim()
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    limit: Number(limitSelect.value),
  }
}

function timelineQuery(): TimelineQueryDto {
  return {
    ...scopedQuery(),
    ...(kindSelect.value ? { kind: kindSelect.value as TimelineObservationKind } : {}),
  }
}

function clearLiveIndicator(): void {
  pendingLiveData = false
  refreshButton.textContent = '刷新'
  refreshButton.classList.remove('has-update')
}

function markLiveDataAvailable(): void {
  if (pendingLiveData) return
  pendingLiveData = true
  refreshButton.textContent = '刷新 · 有新数据'
  refreshButton.classList.add('has-update')
}

function renderEvidence(item: TimelineItemDto): HTMLElement {
  const details = element('details', 'evidence')
  details.append(element('summary', '', `证据 ${item.evidence.length} 条`))
  const list = element('div', 'evidence-list')
  for (const evidence of item.evidence) {
    const row = element('div', 'evidence-row')
    const labels = element('div', 'evidence-labels')
    labels.append(
      element('span', 'pill', CAPTURE_LABELS[evidence.captureMethod]),
      element('span', 'pill subtle', DERIVATION_LABELS[evidence.derivation]),
      element('span', `pill confidence confidence-${evidence.confidence}`, `置信度：${CONFIDENCE_LABELS[evidence.confidence]}`),
    )
    const location = evidence.sourceLocator?.path
      ?? evidence.sourceLocator?.hookEventId
      ?? evidence.sourceLocator?.table
      ?? evidence.sourceRecordId
      ?? '无来源定位信息'
    row.append(labels, element('div', 'evidence-meta', location))
    list.append(row)
  }
  details.append(list)
  return details
}

function renderRawPayload(item: TimelineItemDto): HTMLElement {
  const details = element('details', 'raw-data')
  details.append(element('summary', '', '查看原始数据'))
  const payload = element('pre', 'payload')
  payload.textContent = JSON.stringify(item.payload, null, 2)
  details.append(payload)
  return details
}

function renderTimelineItem(item: TimelineItemDto): HTMLElement {
  const card = element('article', `timeline-item kind-${item.kind.replaceAll('.', '-')}`)
  card.dataset.observationId = item.id
  const rail = element('div', 'timeline-rail')
  rail.append(element('span', 'timeline-dot'))
  const body = element('div', 'timeline-body')
  const top = element('div', 'timeline-item-top')
  const title = element('div', 'timeline-title')
  title.append(
    element('span', 'kind-badge', KIND_LABELS[item.kind]),
    element('strong', '', sourceName(item.sourceId)),
    element('span', 'muted', item.productId),
  )
  top.append(title, element('time', 'timeline-time', formatTime(item.effectiveAt)))

  const fields = element('div', 'payload-summary')
  for (const field of summarizePayload(item.payload)) {
    const row = element('div', 'summary-field')
    row.append(element('span', 'summary-field-label', field.label), element('div', 'summary-field-value', field.value))
    fields.append(row)
  }

  const meta = element('div', 'identifiers')
  meta.append(
    element('span', '', `会话 ${item.logicalSessionId}`),
    element('span', '', `安装 ${item.installationId}`),
  )
  if (item.interactionId) meta.append(element('span', '', `交互 ${item.interactionId}`))

  body.append(top, fields, meta, renderEvidence(item), renderRawPayload(item))
  card.append(rail, body)
  return card
}

function detailsState(node: HTMLElement): Record<string, boolean> {
  return {
    evidence: node.querySelector<HTMLDetailsElement>('details.evidence')?.open === true,
    raw: node.querySelector<HTMLDetailsElement>('details.raw-data')?.open === true,
  }
}

function restoreDetailsState(node: HTMLElement, state: Record<string, boolean>): void {
  const evidence = node.querySelector<HTMLDetailsElement>('details.evidence')
  const raw = node.querySelector<HTMLDetailsElement>('details.raw-data')
  if (evidence && state.evidence) evidence.open = true
  if (raw && state.raw) raw.open = true
}

function renderTimeline(items: TimelineItemDto[], incremental: boolean): void {
  const existingContainer = content.querySelector<HTMLElement>('.timeline')
  if (!incremental || !existingContainer) {
    timelineState = new Map()
    if (!items.length) {
      content.replaceChildren(element('div', 'empty-state', '当前筛选条件下没有执行记录。'))
      return
    }
    const container = element('div', 'timeline')
    for (const item of items) {
      const snapshot = JSON.stringify(item)
      const node = renderTimelineItem(item)
      timelineState.set(item.id, { node, snapshot })
      container.append(node)
    }
    content.replaceChildren(container)
    return
  }

  if (!items.length) {
    timelineState.clear()
    content.replaceChildren(element('div', 'empty-state', '当前筛选条件下没有执行记录。'))
    return
  }

  const oldState = timelineState
  const firstStable = items.map(item => oldState.get(item.id)?.node).find((node): node is HTMLElement => Boolean(node))
  const preserveScroll = window.scrollY > 80 && Boolean(firstStable)
  const anchorTopBefore = preserveScroll ? firstStable!.getBoundingClientRect().top : 0
  const nextState = new Map<string, TimelineRenderState>()
  const desiredNodes: HTMLElement[] = []

  for (const item of items) {
    const snapshot = JSON.stringify(item)
    const previous = oldState.get(item.id)
    let node: HTMLElement
    if (previous?.snapshot === snapshot) {
      node = previous.node
    } else {
      const state = previous ? detailsState(previous.node) : {}
      node = renderTimelineItem(item)
      restoreDetailsState(node, state)
    }
    nextState.set(item.id, { node, snapshot })
    desiredNodes.push(node)
  }

  for (let index = 0; index < desiredNodes.length; index += 1) {
    const desired = desiredNodes[index]!
    const current = existingContainer.children.item(index)
    if (current !== desired) existingContainer.insertBefore(desired, current)
  }
  while (existingContainer.children.length > desiredNodes.length) existingContainer.lastElementChild?.remove()
  timelineState = nextState

  if (preserveScroll && firstStable?.isConnected) {
    const delta = firstStable.getBoundingClientRect().top - anchorTopBefore
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta)
  }
}

function renderSession(session: SessionDetailDto): HTMLElement {
  const card = element('article', 'panel-card session-card')
  const top = element('div', 'panel-card-top')
  const title = element('div', 'panel-title')
  title.append(
    element('strong', '', session.productId),
    element('span', 'pill', session.sourceIds.map(sourceName).join(' / ') || '未知来源'),
  )
  const action = element('button', 'link-button', '查看执行轨迹')
  action.type = 'button'
  action.addEventListener('click', () => {
    sessionInput.value = session.id
    activateView('timeline')
  })
  top.append(title, action)

  const time = element('div', 'session-time', `${formatTime(session.startedAt)} → ${formatTime(session.endedAt)}`)
  const stats = element('div', 'stat-grid')
  for (const [label, value] of [
    ['观测事件', session.observationCount],
    ['交互轮次', session.interactionCount],
    ['原生会话', session.nativeSessionIds.length],
  ] as const) {
    const stat = element('div', 'stat')
    stat.append(element('strong', '', String(value)), element('span', '', label))
    stats.append(stat)
  }

  const distribution = element('div', 'distribution')
  const ranked = Object.entries(session.observationCounts)
    .filter((entry): entry is [TimelineObservationKind, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
  for (const [kind, value] of ranked) distribution.append(element('span', 'pill subtle', `${KIND_LABELS[kind]} ${value}`))

  const ids = element('div', 'identifiers')
  ids.append(element('span', '', `逻辑会话 ${session.id}`), element('span', '', `安装 ${session.installationId}`))

  const interactions = element('div', 'interaction-list')
  interactions.append(element('h3', 'subsection-title', '交互明细'))
  if (!session.interactions.length) interactions.append(element('div', 'empty-inline', '该会话暂未派生出交互轮次。'))
  for (const interaction of session.interactions) {
    const row = element('div', 'interaction-row')
    const left = element('div', 'interaction-main')
    left.append(
      element('span', 'interaction-index', `#${interaction.ordinal}`),
      element('strong', '', interaction.trigger === 'user' ? '用户触发' : '后台活动'),
    )
    row.append(
      left,
      element('span', '', `${interaction.observationCount} 个事件`),
      element('span', 'muted', `${formatTime(interaction.startedAt)} → ${formatTime(interaction.endedAt)}`),
    )
    interactions.append(row)
  }

  card.append(top, time, stats, distribution, ids, interactions)
  return card
}

function renderUsage(response: ToolAssetUsageResponseDto): HTMLElement[] {
  const result: HTMLElement[] = []
  const overview = element('section', 'usage-overview')
  for (const [label, value, hint] of [
    ['工具', response.meta.toolCount, '实际出现过的工具'],
    ['可归因能力', response.meta.assetCount, '目前只做有证据的 MCP / Skill 归因'],
    ['未归因调用', response.meta.unattributedToolCalls, '刻意保留，不强行猜测'],
  ] as const) {
    const stat = element('div', 'overview-stat')
    stat.append(element('strong', '', String(value)), element('span', '', label), element('small', '', hint))
    overview.append(stat)
  }
  result.push(overview)

  const toolSection = element('section', 'panel-card')
  toolSection.append(element('h2', 'section-title', '工具使用'))
  if (!response.tools.length) toolSection.append(element('div', 'empty-inline', '当前范围内没有工具调用。'))
  const table = element('div', 'usage-table')
  for (const tool of response.tools) {
    const row = element('div', 'usage-row')
    const toolMain = element('div', 'usage-main')
    toolMain.append(element('strong', '', tool.nativeToolName), element('span', 'muted', tool.sourceIds.map(sourceName).join(' / ')))
    const metrics = element('div', 'usage-metrics')
    for (const [label, value, danger] of [
      ['调用', tool.callCount, false], ['结果', tool.resultCount, false], ['成功', tool.successCount, false], ['错误', tool.errorCount, tool.errorCount > 0],
    ] as const) {
      const metric = element('span', danger ? 'metric danger' : 'metric')
      metric.append(element('strong', '', String(value)), document.createTextNode(label))
      metrics.append(metric)
    }
    const duration = element('span', 'duration', `累计 ${formatDuration(tool.totalDurationMs)}`)
    row.append(toolMain, metrics, duration)
    table.append(row)
  }
  toolSection.append(table)
  result.push(toolSection)

  const assetSection = element('section', 'panel-card')
  assetSection.append(element('h2', 'section-title', '已归因能力'))
  if (!response.assets.length) assetSection.append(element('div', 'empty-inline', '当前范围内没有足够证据支持能力归因。'))
  const assetList = element('div', 'asset-list')
  for (const asset of response.assets) {
    const row = element('div', 'asset-row')
    row.append(
      element('span', 'kind-badge', asset.type === 'mcp' ? 'MCP' : 'Skill'),
      element('strong', '', asset.canonicalName),
      element('span', '', `${asset.callCount} 次调用`),
      element('span', 'muted', `派生归因 · ${CONFIDENCE_LABELS[asset.confidence]}置信度`),
    )
    assetList.append(row)
  }
  assetSection.append(assetList)
  result.push(assetSection)
  return result
}

function renderLoading(): void {
  content.replaceChildren(element('div', 'empty-state', '正在加载…'))
}

function renderError(error: unknown): void {
  errorBox.hidden = false
  errorBox.textContent = error instanceof Error ? error.message : String(error)
}

async function refreshHealth(): Promise<void> {
  try {
    const health = await getHealth()
    healthBadge.className = `health-badge ${health.status === 'ok' ? 'health-ok' : 'health-degraded'}`
    healthBadge.textContent = health.status === 'ok'
      ? `Daemon 在线 · Schema ${health.storage.schemaVersion ?? '?'}`
      : 'Daemon 状态异常'
  } catch {
    healthBadge.className = 'health-badge health-offline'
    healthBadge.textContent = 'Daemon 离线'
  }
}

async function refreshView(options: { showLoading?: boolean } = {}): Promise<void> {
  const generation = ++refreshGeneration
  const view = currentView
  refreshButton.disabled = true
  errorBox.hidden = true
  if (options.showLoading) renderLoading()

  try {
    if (view === 'timeline') {
      const response = await getTimeline(timelineQuery())
      if (generation !== refreshGeneration || currentView !== view) return
      countText.textContent = `${response.meta.count} 条执行记录`
      noticeText.textContent = response.meta.hasMore ? '还有更多记录，可提高返回数量。' : `更新于 ${formatTime(response.meta.generatedAt)}`
      renderTimeline(response.items, false)
    } else if (view === 'sessions') {
      const response = await getSessions(scopedQuery())
      if (generation !== refreshGeneration || currentView !== view) return
      countText.textContent = `${response.meta.count} 个会话`
      noticeText.textContent = response.meta.hasMore ? '还有更多会话，可提高返回数量。' : `更新于 ${formatTime(response.meta.generatedAt)}`
      content.replaceChildren(...(response.items.length ? response.items.map(renderSession) : [element('div', 'empty-state', '当前筛选条件下没有会话。')]))
    } else {
      const response = await getUsage(scopedQuery())
      if (generation !== refreshGeneration || currentView !== view) return
      countText.textContent = `${response.meta.toolCount} 个工具 · ${response.meta.assetCount} 个可归因能力`
      noticeText.textContent = `${response.meta.unattributedToolCalls} 次工具调用保持未归因`
      content.replaceChildren(...renderUsage(response))
    }
    clearLiveIndicator()
  } catch (error) {
    if (generation !== refreshGeneration || currentView !== view) return
    renderError(error)
  } finally {
    if (generation === refreshGeneration) refreshButton.disabled = false
  }
}

async function applyTimelineLiveUpdate(): Promise<void> {
  const response = await getTimeline(timelineQuery())
  if (currentView !== 'timeline') {
    markLiveDataAvailable()
    return
  }
  countText.textContent = `${response.meta.count} 条执行记录`
  noticeText.textContent = response.meta.hasMore ? '还有更多记录，可提高返回数量。' : `实时更新 · ${formatTime(response.meta.generatedAt)}`
  renderTimeline(response.items, true)
}

function scheduleLiveUpdate(): void {
  if (liveUpdateTimer !== undefined) window.clearTimeout(liveUpdateTimer)
  liveUpdateTimer = window.setTimeout(() => {
    liveUpdateTimer = undefined
    if (currentView !== 'timeline') {
      markLiveDataAvailable()
      return
    }
    void applyTimelineLiveUpdate().catch(() => markLiveDataAvailable())
  }, 500)
}

function activateView(view: ViewId): void {
  currentView = view
  refreshGeneration += 1
  timelineState.clear()
  clearLiveIndicator()
  for (const [id, button] of viewButtons) button.classList.toggle('active', id === view)
  kindField.hidden = view !== 'timeline'
  void refreshView({ showLoading: true })
}

for (const [id, button] of viewButtons) button.addEventListener('click', () => activateView(id))
refreshButton.addEventListener('click', () => void Promise.all([refreshHealth(), refreshView()]))
applyFiltersButton.addEventListener('click', () => void refreshView({ showLoading: true }))
clearFiltersButton.addEventListener('click', () => {
  kindSelect.value = ''
  installationInput.value = ''
  sessionInput.value = ''
  limitSelect.value = '100'
  void refreshView({ showLoading: true })
})
subscribeUpdates(scheduleLiveUpdate)
activateView('timeline')
void refreshHealth()
