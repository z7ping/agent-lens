import {
  AGENT_LENS_PROTOCOL_VERSION,
  TIMELINE_OBSERVATION_KINDS,
  type SessionDetailDto,
  type TimelineItemDto,
  type TimelineObservationKind,
  type TimelineQueryDto,
  type ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { getHealth, getSessions, getTimeline, getUsage, subscribeUpdates } from './api'
import './styles.css'

type ViewId = 'timeline' | 'sessions' | 'usage'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatTime(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)
}

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('AgentLens app root was not found')

const shell = element('div', 'shell')
const header = element('header', 'topbar')
const brand = element('div', 'brand')
brand.append(element('div', 'brand-mark', 'AL'), element('div', 'brand-copy'))
brand.querySelector('.brand-copy')!.append(element('strong', '', 'AgentLens'), element('span', '', `Protocol ${AGENT_LENS_PROTOCOL_VERSION}`))
const healthBadge = element('div', 'health-badge health-loading', 'Checking daemon…')
header.append(brand, healthBadge)

const nav = element('nav', 'view-nav')
const viewButtons = new Map<ViewId, HTMLButtonElement>()
for (const [id, label] of [['timeline', 'Timeline'], ['sessions', 'Sessions'], ['usage', 'Tools & Assets']] as const) {
  const button = element('button', 'view-tab', label)
  button.type = 'button'
  button.dataset.view = id
  nav.append(button)
  viewButtons.set(id, button)
}

const toolbar = element('section', 'toolbar')
const kindSelect = element('select', 'control')
kindSelect.append(new Option('All event kinds', ''))
for (const kind of TIMELINE_OBSERVATION_KINDS) kindSelect.append(new Option(kind, kind))
const installationInput = element('input', 'control')
installationInput.placeholder = 'Installation ID (optional)'
const sessionInput = element('input', 'control')
sessionInput.placeholder = 'Logical session ID (optional)'
const limitSelect = element('select', 'control')
for (const limit of [50, 100, 200, 500]) limitSelect.append(new Option(`${limit} items`, String(limit)))
limitSelect.value = '100'
const refreshButton = element('button', 'refresh-button', 'Refresh')
refreshButton.type = 'button'
toolbar.append(kindSelect, installationInput, sessionInput, limitSelect, refreshButton)

const summary = element('section', 'summary-row')
const countText = element('span', 'summary-count', 'No data loaded')
const noticeText = element('span', 'summary-note', '')
summary.append(countText, noticeText)
const errorBox = element('div', 'error-box')
errorBox.hidden = true
const content = element('section', 'content')
shell.append(header, nav, toolbar, summary, errorBox, content)
root.replaceChildren(shell)

let currentView: ViewId = 'timeline'
let liveRefreshTimer: number | undefined

function scopedQuery() {
  const installationId = installationInput.value.trim()
  const logicalSessionId = sessionInput.value.trim()
  return {
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    limit: Number(limitSelect.value),
  }
}

function renderEvidence(item: TimelineItemDto): HTMLElement {
  const details = element('details', 'evidence')
  details.append(element('summary', '', `${item.evidence.length} evidence record${item.evidence.length === 1 ? '' : 's'}`))
  const list = element('div', 'evidence-list')
  for (const evidence of item.evidence) {
    const row = element('div', 'evidence-row')
    const labels = element('div', 'evidence-labels')
    labels.append(element('span', 'pill', evidence.captureMethod), element('span', 'pill subtle', evidence.derivation), element('span', `pill confidence confidence-${evidence.confidence}`, evidence.confidence))
    const location = evidence.sourceLocator?.path ?? evidence.sourceLocator?.hookEventId ?? evidence.sourceLocator?.table ?? evidence.sourceRecordId ?? 'no source locator'
    row.append(labels, element('div', 'evidence-meta', location))
    list.append(row)
  }
  details.append(list)
  return details
}

function renderTimelineItem(item: TimelineItemDto): HTMLElement {
  const card = element('article', 'timeline-item')
  const rail = element('div', 'timeline-rail'); rail.append(element('span', 'timeline-dot'))
  const body = element('div', 'timeline-body')
  const top = element('div', 'timeline-item-top')
  const title = element('div', 'timeline-title')
  title.append(element('span', 'kind-badge', item.kind), element('strong', '', item.sourceId), element('span', 'muted', item.productId))
  top.append(title, element('time', 'timeline-time', formatTime(item.effectiveAt)))
  const identifiers = element('div', 'identifiers')
  identifiers.append(element('span', '', `session ${item.logicalSessionId}`), element('span', '', `installation ${item.installationId}`))
  const payload = element('pre', 'payload'); payload.textContent = JSON.stringify(item.payload, null, 2)
  body.append(top, identifiers, payload, renderEvidence(item)); card.append(rail, body)
  return card
}

function renderSession(session: SessionDetailDto): HTMLElement {
  const card = element('article', 'panel-card')
  const top = element('div', 'panel-card-top')
  const title = element('div', 'panel-title')
  title.append(element('strong', '', session.productId), element('span', 'pill', session.sourceIds.join(', ') || 'unknown source'))
  top.append(title, element('span', 'muted', `${formatTime(session.startedAt)} → ${formatTime(session.endedAt)}`))
  const stats = element('div', 'stat-grid')
  for (const [label, value] of [['Observations', session.observationCount], ['Interactions', session.interactionCount], ['Native sessions', session.nativeSessionIds.length]]) {
    const stat = element('div', 'stat'); stat.append(element('strong', '', String(value)), element('span', '', label)); stats.append(stat)
  }
  const ids = element('div', 'identifiers')
  ids.append(element('span', '', `logical ${session.id}`), element('span', '', `installation ${session.installationId}`))
  const interactions = element('div', 'interaction-list')
  for (const interaction of session.interactions) {
    const row = element('div', 'interaction-row')
    row.append(element('span', 'pill', `#${interaction.ordinal} ${interaction.trigger}`), element('span', '', `${interaction.observationCount} observations`), element('span', 'muted', `${formatTime(interaction.startedAt)} → ${formatTime(interaction.endedAt)}`))
    interactions.append(row)
  }
  card.append(top, stats, ids, interactions)
  return card
}

function renderUsage(response: ToolAssetUsageResponseDto): HTMLElement[] {
  const result: HTMLElement[] = []
  const toolSection = element('section', 'panel-card')
  toolSection.append(element('h2', 'section-title', 'Tools'))
  const table = element('div', 'usage-table')
  table.append(element('div', 'usage-row usage-head', 'Tool · Calls · Results · Errors · Duration · Sources'))
  for (const tool of response.tools) {
    const row = element('div', 'usage-row')
    row.append(element('strong', '', tool.nativeToolName), element('span', '', `${tool.callCount} calls`), element('span', '', `${tool.resultCount} results`), element('span', tool.errorCount ? 'danger' : '', `${tool.errorCount} errors`), element('span', '', `${Math.round(tool.totalDurationMs)} ms`), element('span', 'muted', tool.sourceIds.join(', ')))
    table.append(row)
  }
  toolSection.append(table)
  result.push(toolSection)

  const assetSection = element('section', 'panel-card')
  assetSection.append(element('h2', 'section-title', 'Attributed asset usage'))
  if (!response.assets.length) assetSection.append(element('div', 'empty-inline', 'No defensible asset attribution in this scope.'))
  for (const asset of response.assets) {
    const row = element('div', 'asset-row')
    row.append(element('span', 'kind-badge', asset.type), element('strong', '', asset.canonicalName), element('span', '', `${asset.callCount} calls`), element('span', 'muted', `${asset.attribution} · ${asset.confidence} confidence`))
    assetSection.append(row)
  }
  result.push(assetSection)
  return result
}

function renderLoading(): void { content.replaceChildren(element('div', 'empty-state', 'Loading…')) }
function renderError(error: unknown): void { errorBox.hidden = false; errorBox.textContent = error instanceof Error ? error.message : String(error) }

async function refreshHealth(): Promise<void> {
  try {
    const health = await getHealth()
    healthBadge.className = `health-badge ${health.status === 'ok' ? 'health-ok' : 'health-degraded'}`
    healthBadge.textContent = health.status === 'ok' ? `Daemon online · schema ${health.storage.schemaVersion ?? '?'}` : 'Daemon degraded'
  } catch { healthBadge.className = 'health-badge health-offline'; healthBadge.textContent = 'Daemon offline' }
}

async function refreshView(): Promise<void> {
  refreshButton.disabled = true; errorBox.hidden = true; renderLoading()
  try {
    if (currentView === 'timeline') {
      const query: TimelineQueryDto = { ...scopedQuery(), ...(kindSelect.value ? { kind: kindSelect.value as TimelineObservationKind } : {}) }
      const response = await getTimeline(query)
      countText.textContent = `${response.meta.count} observations`
      noticeText.textContent = response.meta.hasMore ? 'More observations match this query.' : `Generated ${formatTime(response.meta.generatedAt)}`
      content.replaceChildren(...(response.items.length ? response.items.map(renderTimelineItem) : [element('div', 'empty-state', 'No observations match this filter.')]))
    } else if (currentView === 'sessions') {
      const response = await getSessions(scopedQuery())
      countText.textContent = `${response.meta.count} sessions`
      noticeText.textContent = response.meta.hasMore ? 'More sessions match this query.' : `Generated ${formatTime(response.meta.generatedAt)}`
      content.replaceChildren(...(response.items.length ? response.items.map(renderSession) : [element('div', 'empty-state', 'No sessions match this filter.')]))
    } else {
      const response = await getUsage(scopedQuery())
      countText.textContent = `${response.meta.toolCount} tools · ${response.meta.assetCount} attributed assets`
      noticeText.textContent = `${response.meta.unattributedToolCalls} tool calls intentionally left unattributed`
      content.replaceChildren(...renderUsage(response))
    }
  } catch (error) { content.replaceChildren(element('div', 'empty-state', 'View could not be loaded.')); renderError(error) }
  finally { refreshButton.disabled = false }
}

function scheduleLiveRefresh(): void {
  if (liveRefreshTimer !== undefined) window.clearTimeout(liveRefreshTimer)
  liveRefreshTimer = window.setTimeout(() => {
    liveRefreshTimer = undefined
    void refreshView()
  }, 150)
}

function activateView(view: ViewId): void {
  currentView = view
  for (const [id, button] of viewButtons) button.classList.toggle('active', id === view)
  kindSelect.hidden = view !== 'timeline'
  void refreshView()
}

for (const [id, button] of viewButtons) button.addEventListener('click', () => activateView(id))
refreshButton.addEventListener('click', () => void Promise.all([refreshHealth(), refreshView()]))
kindSelect.addEventListener('change', () => void refreshView())
limitSelect.addEventListener('change', () => void refreshView())
subscribeUpdates(scheduleLiveRefresh)
activateView('timeline')
void refreshHealth()
