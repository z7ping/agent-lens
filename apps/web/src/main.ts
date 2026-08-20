import {
  AGENT_LENS_PROTOCOL_VERSION,
  TIMELINE_OBSERVATION_KINDS,
  type TimelineItemDto,
  type TimelineObservationKind,
  type TimelineQueryDto,
} from '@agent-lens/protocol'
import { getHealth, getTimeline } from './api'
import './styles.css'

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

function formatTime(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(time)
}

function payloadText(payload: TimelineItemDto['payload']): string {
  return JSON.stringify(payload, null, 2)
}

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('AgentLens app root was not found')

const shell = element('div', 'shell')
const header = element('header', 'topbar')
const brand = element('div', 'brand')
brand.append(
  element('div', 'brand-mark', 'AL'),
  element('div', 'brand-copy'),
)
brand.querySelector('.brand-copy')!.append(
  element('strong', '', 'AgentLens'),
  element('span', '', `Protocol ${AGENT_LENS_PROTOCOL_VERSION}`),
)

const healthBadge = element('div', 'health-badge health-loading', 'Checking daemon…')
header.append(brand, healthBadge)

const toolbar = element('section', 'toolbar')
const kindSelect = element('select', 'control')
kindSelect.append(new Option('All event kinds', ''))
for (const kind of TIMELINE_OBSERVATION_KINDS) kindSelect.append(new Option(kind, kind))

const installationInput = element('input', 'control')
installationInput.placeholder = 'Installation ID (optional)'
installationInput.autocomplete = 'off'

const sessionInput = element('input', 'control')
sessionInput.placeholder = 'Logical session ID (optional)'
sessionInput.autocomplete = 'off'

const limitSelect = element('select', 'control')
for (const limit of [50, 100, 200, 500]) limitSelect.append(new Option(`${limit} events`, String(limit)))
limitSelect.value = '200'

const refreshButton = element('button', 'refresh-button', 'Refresh')
refreshButton.type = 'button'
toolbar.append(kindSelect, installationInput, sessionInput, limitSelect, refreshButton)

const summary = element('section', 'summary-row')
const countText = element('span', 'summary-count', 'No timeline loaded')
const noticeText = element('span', 'summary-note', '')
summary.append(countText, noticeText)

const content = element('section', 'timeline')
const errorBox = element('div', 'error-box')
errorBox.hidden = true

shell.append(header, toolbar, summary, errorBox, content)
root.replaceChildren(shell)

function queryFromControls(): TimelineQueryDto {
  const kind = kindSelect.value as TimelineObservationKind | ''
  const installationId = installationInput.value.trim()
  const logicalSessionId = sessionInput.value.trim()
  return {
    ...(kind ? { kind } : {}),
    ...(installationId ? { installationId } : {}),
    ...(logicalSessionId ? { logicalSessionId } : {}),
    limit: Number(limitSelect.value),
  }
}

function renderEvidence(item: TimelineItemDto): HTMLElement {
  const details = element('details', 'evidence')
  const summary = element(
    'summary',
    '',
    `${item.evidence.length} evidence ${item.evidence.length === 1 ? 'record' : 'records'}`,
  )
  details.append(summary)

  const list = element('div', 'evidence-list')
  for (const evidence of item.evidence) {
    const row = element('div', 'evidence-row')
    const labels = element('div', 'evidence-labels')
    labels.append(
      element('span', 'pill', evidence.captureMethod),
      element('span', 'pill subtle', evidence.derivation),
      element('span', `pill confidence confidence-${evidence.confidence}`, evidence.confidence),
    )
    const meta = element('div', 'evidence-meta')
    const location = evidence.sourceLocator?.path
      ?? evidence.sourceLocator?.hookEventId
      ?? evidence.sourceLocator?.table
      ?? evidence.sourceRecordId
      ?? 'no source locator'
    meta.textContent = location
    row.append(labels, meta)
    list.append(row)
  }
  details.append(list)
  return details
}

function renderTimelineItem(item: TimelineItemDto): HTMLElement {
  const card = element('article', 'timeline-item')
  card.dataset.kind = item.kind

  const rail = element('div', 'timeline-rail')
  rail.append(element('span', 'timeline-dot'))

  const body = element('div', 'timeline-body')
  const top = element('div', 'timeline-item-top')
  const title = element('div', 'timeline-title')
  title.append(
    element('span', 'kind-badge', item.kind),
    element('strong', '', item.sourceId),
    element('span', 'muted', item.productId),
  )
  top.append(title, element('time', 'timeline-time', formatTime(item.effectiveAt)))

  const identifiers = element('div', 'identifiers')
  identifiers.append(
    element('span', '', `session ${item.logicalSessionId}`),
    element('span', '', `installation ${item.installationId}`),
  )

  const payload = element('pre', 'payload')
  payload.textContent = payloadText(item.payload)

  body.append(top, identifiers, payload, renderEvidence(item))
  card.append(rail, body)
  return card
}

function renderLoading(): void {
  content.replaceChildren(element('div', 'empty-state', 'Loading canonical observations…'))
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
      ? `Daemon online · schema ${health.storage.schemaVersion ?? '?'}`
      : 'Daemon degraded'
  } catch {
    healthBadge.className = 'health-badge health-offline'
    healthBadge.textContent = 'Daemon offline'
  }
}

async function refreshTimeline(): Promise<void> {
  refreshButton.disabled = true
  errorBox.hidden = true
  renderLoading()
  try {
    const response = await getTimeline(queryFromControls())
    countText.textContent = `${response.meta.count} observations`
    noticeText.textContent = response.meta.hasMore
      ? 'More observations match this query; narrow the filter or raise the limit.'
      : `Generated ${formatTime(response.meta.generatedAt)}`

    if (!response.items.length) {
      content.replaceChildren(element('div', 'empty-state', 'No observations match this filter.'))
      return
    }
    content.replaceChildren(...response.items.map(renderTimelineItem))
  } catch (error) {
    content.replaceChildren(element('div', 'empty-state', 'Timeline could not be loaded.'))
    renderError(error)
  } finally {
    refreshButton.disabled = false
  }
}

refreshButton.addEventListener('click', () => {
  void Promise.all([refreshHealth(), refreshTimeline()])
})
kindSelect.addEventListener('change', () => void refreshTimeline())
limitSelect.addEventListener('change', () => void refreshTimeline())

void Promise.all([refreshHealth(), refreshTimeline()])
