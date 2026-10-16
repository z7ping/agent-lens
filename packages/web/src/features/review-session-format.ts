import type { HubReadAvailability, HubReviewSessionSummaryDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { agentLensI18n } from '../i18n/runtime'

export function currentLocale(): string {
  return agentLensI18n.resolvedLanguage ?? agentLensI18n.language ?? 'zh-CN'
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function formatClock(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}

function formatHourMinute(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

export type ReviewDayGroup = 'today' | 'yesterday' | 'earlier'

export function sessionDayLabel(value: string, now = new Date()): ReviewDayGroup {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'earlier'
  const day = localDayStart(date)
  const today = localDayStart(now)
  if (day === today) return 'today'
  if (day === today - 86_400_000) return 'yesterday'
  return 'earlier'
}

export function sessionRelativeTime(value: string, now = new Date()): string {
  const t = agentLensI18n.t.bind(agentLensI18n)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const group = sessionDayLabel(value, now)
  if (group === 'today') {
    const diff = Math.max(0, now.getTime() - date.getTime())
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return t('review:local.time.justNow')
    if (minutes < 60) return t('review:local.time.minutesAgo', { count: minutes })
    const hours = Math.floor(diff / 3_600_000)
    if (hours <= 1) return t('review:local.time.aboutHourAgo')
    return t('review:local.time.hoursAgo', { count: hours })
  }
  if (group === 'yesterday') return t('review:local.time.yesterdayAt', { time: formatHourMinute(value) })
  if (date.getFullYear() === now.getFullYear()) return t('review:local.time.monthDayAt', { month: date.getMonth() + 1, day: date.getDate(), time: formatHourMinute(value) })
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

export function duration(ms: number): string {
  const t = agentLensI18n.t.bind(agentLensI18n)
  const value = Math.max(0, ms)
  if (value < 1000) return t('review:local.duration.milliseconds', { value })
  if (value < 60_000) return t('review:local.duration.seconds', { value: (value / 1000).toFixed(value < 10_000 ? 1 : 0) })
  if (value < 3_600_000) return t('review:local.duration.minutes', { value: Math.round(value / 60_000) })
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return t('review:local.duration.hours', { value: hours < 10 ? hours.toFixed(1) : Math.round(hours) })
  }
  const days = value / 86_400_000
  return t('review:local.duration.days', { value: days < 10 ? days.toFixed(1) : Math.round(days) })
}

export function elapsed(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function cleanSessionTitle(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

export function compactTitle(value: string | undefined, max = 92, fallback = agentLensI18n.t('review:local.session.unnamed')): string {
  const text = cleanSessionTitle(value)
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function hubAvailabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
}

export function hubSessionTime(item: HubReviewSessionSummaryDto): string {
  return hubAvailabilityString(item.endedAt) ?? hubAvailabilityString(item.startedAt) ?? ''
}

export function hubSessionTitle(item: HubReviewSessionSummaryDto): string {
  const value = hubAvailabilityString(item.title)
  if (value) return compactTitle(value, 74, agentLensI18n.t('review:local.session.remote'))
  if (item.title.state === 'redacted') return agentLensI18n.t('review:local.session.titleRedacted')
  if (item.title.state === 'omitted') return item.title.reason === 'policy'
    ? agentLensI18n.t('review:local.session.titleNotSynced')
    : agentLensI18n.t('review:local.session.remote')
  return agentLensI18n.t('review:local.session.remote')
}

export function hubSessionVisibility(item: HubReviewSessionSummaryDto, review: ReturnType<AgentLensClientModel['getSnapshot']>['review']): boolean {
  if (review.filters.sourceIds !== null || review.filters.projectId || review.filters.status !== 'all') return false
  const search = review.filters.search.trim().toLowerCase()
  if (search && !hubSessionTitle(item).toLowerCase().includes(search) && !item.origin.nodeId.toLowerCase().includes(search)) return false
  const time = hubSessionTime(item)
  if (!time || review.filters.range === 'all') return true
  const at = Date.parse(time)
  if (!Number.isFinite(at)) return false
  const now = Date.now()
  if (review.filters.range === 'today') return localDayStart(new Date(at)) === localDayStart(new Date(now))
  const days = review.filters.range === '7d' ? 7 : 30
  return at >= now - days * 86_400_000
}

export type UnifiedReviewSessionListEntry =
  | { origin: 'local'; id: string; activityAt: string; local: ReviewSessionSummaryDto }
  | { origin: 'remote'; id: string; activityAt: string; remote: HubReviewSessionSummaryDto }

