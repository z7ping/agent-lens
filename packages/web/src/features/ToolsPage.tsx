import { useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { ToolUsageDto } from '@agent-lens/protocol'
import { AgentLensApi } from '../client/api'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { Drawer, IconButton, SelectMenu, UiIcon } from '../components/ui'

const toolDetailApi = new AgentLensApi()

function duration(ms: number, t: TFunction): string {
  if (ms <= 0) return t('duration.unobserved')
  if (ms < 1000) return t('duration.milliseconds', { value: ms })
  if (ms < 60_000) return t('duration.seconds', { value: (ms / 1000).toFixed(1) })
  return t('duration.minutes', { value: (ms / 60_000).toFixed(1) })
}

function rateValue(success: number, error: number): number | null {
  const total = success + error
  if (!total) return null
  const rounded = Math.round(success / total * 1000) / 10
  return error > 0 ? Math.min(99.9, rounded) : rounded
}

function rate(success: number, error: number): string {
  const value = rateValue(success, error)
  if (value === null) return '—'
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`
}

function formatSessionTime(value: string | undefined, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function assetTypeLabel(type: string, t: TFunction): string {
  if (type === 'skill') return t('assetType.skill')
  if (type === 'mcp') return t('assetType.mcp')
  return t('assetType.other')
}

function confidenceLabel(confidence: string, t: TFunction): string {
  if (confidence === 'high') return t('confidence.high')
  if (confidence === 'medium') return t('confidence.medium')
  if (confidence === 'low') return t('confidence.low')
  return t('confidence.unknown')
}

function toolKey(sourceIds: string[], nativeToolName: string): string {
  return `${sourceIds.join('\u0000')}:${nativeToolName}`
}

function sourceLabels(sourceIds: string[]): string {
  return sourceIds.map(sourceId => agentLabel(sourceId)).join(' / ')
}

function shortSessionId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-5)}` : id
}

function sameSourceIds(left: string[] | null, right: string[] | null): boolean {
  if (left === right) return true
  if (left === null || right === null || left.length !== right.length) return false
  return left.every((sourceId, index) => sourceId === right[index])
}

function sameUsageFilters(
  left: { sourceIds: string[] | null; projectId: string; range: string },
  right: { sourceIds: string[] | null; projectId: string; range: string },
): boolean {
  return sameSourceIds(left.sourceIds, right.sourceIds)
    && left.projectId === right.projectId
    && left.range === right.range
}

type SortKey = 'callCount' | 'sessionCount' | 'successRate' | 'errorCount' | 'averageDurationMs'
type SortDirection = 'ascending' | 'descending'

function sortMetric(tool: ToolUsageDto, key: SortKey): number {
  if (key === 'successRate') return rateValue(tool.successCount, tool.errorCount) ?? -1
  return tool[key]
}

export function ToolsPage({ model, sidebarHost }: { model: AgentLensClientModel; sidebarHost?: HTMLDivElement | null }) {
  const { t, i18n } = useTranslation('tools')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const snapshot = useClientSnapshot(model)
  const navigate = useNavigate()
  const usage = snapshot.usage
  const data = usage.response
  const projection = data?.meta.projection
  const projectionPartial = projection?.state === 'partial'
  const projectionPercent = projection ? Math.max(0, Math.min(100, Math.round(projection.coverageRatio * 100))) : 0
  const agents = useOrderedAgents(snapshot.facets?.agents ?? [])
  const projects = snapshot.facets?.projects ?? []
  const agentSelectionSummary = usage.filters.sourceIds === null
    ? t('filters.allAgents')
    : usage.filters.sourceIds.length
      ? t('filters.selectedAgents', { count: usage.filters.sourceIds.length })
      : t('filters.none')
  const tools = data?.tools ?? []
  const assets = data?.assets ?? []
  const mostUsed = [...tools].sort((a, b) => b.callCount - a.callCount)[0]
  const errorCandidate = [...tools].sort((a, b) => b.errorCount - a.errorCount)[0]
  const mostErrors = errorCandidate?.errorCount ? errorCandidate : undefined
  const slowest = [...tools].filter(tool => tool.averageDurationMs > 0).sort((a, b) => b.averageDurationMs - a.averageDurationMs)[0]
  const totalCalls = tools.reduce((sum, tool) => sum + tool.callCount, 0)
  const unattributedCalls = data?.meta.unattributedToolCalls ?? 0
  const attributedCalls = Math.max(0, totalCalls - unattributedCalls)
  const attributionCoverage = totalCalls ? Math.round(attributedCalls / totalCalls * 100) : 0
  const maxCalls = Math.max(1, ...tools.map(tool => tool.callCount))
  const maxAssetCalls = Math.max(1, ...assets.map(asset => asset.callCount))
  const canRelaxFilters = Boolean(usage.filters.sourceIds !== null || usage.filters.projectId || usage.filters.range !== 'all')
  const blockingError = Boolean(usage.error && !data)
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null)
  const [detailTools, setDetailTools] = useState<Map<string, ToolUsageDto>>(() => new Map())
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null)
  const [detailError, setDetailError] = useState('')
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'callCount', direction: 'descending' })
  const selectedSummaryTool = useMemo(() => tools.find(tool => toolKey(tool.sourceIds, tool.nativeToolName) === selectedToolKey), [selectedToolKey, tools])
  const selectedTool = selectedToolKey ? detailTools.get(selectedToolKey) ?? selectedSummaryTool : undefined
  const sessionSummaries = useMemo(() => new Map((snapshot.review.response?.items ?? []).map(item => [item.id, item])), [snapshot.review.response?.items])
  const selectedSessions = useMemo(() => selectedTool
    ? [...selectedTool.sessions].sort((a, b) => (b.errorCount ?? 0) - (a.errorCount ?? 0) || b.callCount - a.callCount || a.logicalSessionId.localeCompare(b.logicalSessionId))
    : [], [selectedTool])
  const firstFailedSession = selectedSessions.find(session => (session.errorCount ?? 0) > 0)
  const sortedTools = useMemo(() => [...tools].sort((a, b) => {
    const delta = sortMetric(a, sort.key) - sortMetric(b, sort.key)
    if (delta === 0) return a.nativeToolName.localeCompare(b.nativeToolName)
    return sort.direction === 'ascending' ? delta : -delta
  }), [tools, sort])
  useEffect(() => {
    setSelectedToolKey(null)
    setDetailTools(new Map())
    setDetailLoadingKey(null)
    setDetailError('')
  }, [usage.filters.sourceIds, usage.filters.projectId, usage.filters.range])

  const selectTool = async (key: string) => {
    setShowAllSessions(false)
    setSelectedToolKey(key)
    setDetailError('')
    if (detailTools.has(key) || detailLoadingKey === key) return
    const summaryTool = tools.find(tool => toolKey(tool.sourceIds, tool.nativeToolName) === key)
    if (!summaryTool) return
    const requestedFilters = { ...usage.filters }
    setDetailLoadingKey(key)
    try {
      const detail = await toolDetailApi.usageDetail(requestedFilters, summaryTool.nativeToolName)
      if (!sameUsageFilters(model.getSnapshot().usage.filters, requestedFilters)) return
      const tool = detail.tools.find(item => toolKey(item.sourceIds, item.nativeToolName) === key)
      if (tool) setDetailTools(current => new Map(current).set(key, tool))
    } catch (error) {
      if (sameUsageFilters(model.getSnapshot().usage.filters, requestedFilters)) {
        setDetailError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setDetailLoadingKey(current => current === key ? null : current)
    }
  }
  const toggleSort = (key: SortKey) => {
    setSort(current => current.key === key
      ? { key, direction: current.direction === 'descending' ? 'ascending' : 'descending' }
      : { key, direction: 'descending' })
  }
  const ariaSort = (key: SortKey): 'none' | SortDirection => sort.key === key ? sort.direction : 'none'
  const sortIcon = (key: SortKey) => sort.key === key
    ? <UiIcon name={sort.direction === 'descending' ? 'sort-down' : 'sort-up'} size={12}/>
    : null
  const sortKeyDown = (event: React.KeyboardEvent<HTMLTableCellElement>, key: SortKey) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleSort(key)
  }
  const relaxFilters = () => model.setUsageFilters({ sourceIds: null, projectId: '', range: 'all' })
  const openReviewSession = (logicalSessionId: string) => {
    const params = new URLSearchParams()
    for (const sourceId of usage.filters.sourceIds ?? []) params.append('source', sourceId)
    if (usage.filters.projectId) params.set('project', usage.filters.projectId)
    params.set('range', usage.filters.range)
    params.set('status', 'all')
    navigate(`/review/${encodeURIComponent(logicalSessionId)}?${params.toString()}`)
  }
  const projectFilterOptions = [
    { value: '', label: t('filters.allProjects') },
    ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
  ]
  const sidebarFilters = <div className="workspace-context-menu workspace-insight-context" aria-label={t('filters.aria')}>
    <div className="workspace-context-utility">
      <span>{agentSelectionSummary}</span>
      <IconButton size="small" onClick={() => void model.refreshUsage()} title={t('filters.refresh')} aria-label={t('filters.refresh')}><UiIcon name="refresh" size={14}/></IconButton>
    </div>
    <SidebarFilterDisclosure className="workspace-insight-filter-disclosure" summaryMeta={agentSelectionSummary} agents={agents} agentSelection={{ mode: 'multiple', value: usage.filters.sourceIds, onChange: sourceIds => model.setUsageFilters({ sourceIds }) }}>
      <div className="workspace-insight-filter-fields">
        <label><span>{t('filters.project')}</span><SelectMenu variant="field" value={usage.filters.projectId} onChange={projectId => model.setUsageFilters({ projectId })} ariaLabel={t('filters.projectAria')} placeholder={t('filters.allProjects')} menuWidth={280} searchable searchPlaceholder={t('filters.searchProject')} options={projectFilterOptions}/></label>
        <label><span>{t('filters.time')}</span><SelectMenu variant="field" value={usage.filters.range} onChange={range => model.setUsageFilters({ range: range as typeof usage.filters.range })} ariaLabel={t('filters.timeAria')} menuWidth={156} options={[
          { value: 'today', label: t('filters.today') }, { value: '7d', label: t('filters.sevenDays') }, { value: '30d', label: t('filters.thirtyDays') }, { value: 'all', label: t('filters.all') },
        ]}/></label>
        {canRelaxFilters && <button type="button" className="workspace-filter-clear" onClick={relaxFilters}>{t('filters.clear')}</button>}
      </div>
    </SidebarFilterDisclosure>
  </div>

  return <>
    {sidebarHost ? createPortal(sidebarFilters, sidebarHost) : null}
    <main className="workspace-page tools-page">
      <div className="page-content tools-content">
        <CompactPageHeading title={t('page.title')} description={t('page.description')}/>

        {usage.error && <ErrorStateBanner message={usage.error} onRetry={() => void model.refreshUsage()}/>} 
        {projectionPartial && projection && <div className="tool-projection-status" role="status" aria-live="polite">
          <UiIcon name="refresh" size={14}/>
          <span><b>{t('page.projectionTitle')}</b><small>{t('page.projectionDescription', { projected: projection.projectedCount.toLocaleString(locale), total: projection.sourceObservationCount.toLocaleString(locale), percent: projectionPercent })}</small></span>
        </div>}

        {blockingError ? null : usage.loading && !data ? <WorkspaceSkeleton kind="table"/> : <>
          <section className="tool-summary-grid">
            <div className="tool-summary-card"><span>{t('page.mostFrequent')}</span><strong>{mostUsed?.nativeToolName ?? '—'}</strong><small>{mostUsed ? t('page.callsAndSessions', { calls: mostUsed.callCount, sessions: mostUsed.sessionCount }) : t('page.noData')}</small></div>
            <div className="tool-summary-card"><span>{t('page.mostFailures')}</span><strong className={mostErrors ? 'is-danger' : ''}>{mostErrors?.nativeToolName ?? '—'}</strong><small>{mostErrors ? t('page.failures', { count: mostErrors.errorCount }) : t('page.noKnownFailures')}</small></div>
            <div className="tool-summary-card"><span>{t('page.slowestAverage')}</span><strong>{slowest?.nativeToolName ?? '—'}</strong><small>{slowest ? t('page.perCall', { duration: duration(slowest.averageDurationMs, t) }) : t('page.noData')}</small></div>
            <div className="tool-summary-card" title={t('page.attributionTitle')}><span>{t('page.attributionCoverage')}</span><strong>{totalCalls ? `${attributionCoverage}%` : '—'}</strong><small>{totalCalls ? t('page.unattributed', { count: unattributedCalls }) : t('page.noCalls')}</small></div>
          </section>

          <section className="tool-table-card">
            <div className="table-section-head"><div><h2>{t('page.toolCalls')}</h2><p>{t('page.tableDescription', { count: tools.length })}</p></div></div>
            <div className="table-scroll">
              {tools.length ? <table className="tool-table">
                <thead><tr>
                  <th>{t('page.tool')}</th>
                  <th tabIndex={0} role="button" aria-sort={ariaSort('callCount')} onClick={() => toggleSort('callCount')} onKeyDown={event => sortKeyDown(event, 'callCount')} style={{ cursor: 'pointer' }}>{t('page.calls')} {sortIcon('callCount')}</th>
                  <th tabIndex={0} role="button" aria-sort={ariaSort('sessionCount')} onClick={() => toggleSort('sessionCount')} onKeyDown={event => sortKeyDown(event, 'sessionCount')} style={{ cursor: 'pointer' }}>{t('page.sessions')} {sortIcon('sessionCount')}</th>
                  <th tabIndex={0} role="button" aria-sort={ariaSort('successRate')} onClick={() => toggleSort('successRate')} onKeyDown={event => sortKeyDown(event, 'successRate')} style={{ cursor: 'pointer' }}>{t('page.successRate')} {sortIcon('successRate')}</th>
                  <th tabIndex={0} role="button" aria-sort={ariaSort('errorCount')} onClick={() => toggleSort('errorCount')} onKeyDown={event => sortKeyDown(event, 'errorCount')} style={{ cursor: 'pointer' }}>{t('page.failure')} {sortIcon('errorCount')}</th>
                  <th tabIndex={0} role="button" aria-sort={ariaSort('averageDurationMs')} onClick={() => toggleSort('averageDurationMs')} onKeyDown={event => sortKeyDown(event, 'averageDurationMs')} style={{ cursor: 'pointer' }}>{t('page.averageDuration')} {sortIcon('averageDurationMs')}</th>
                </tr></thead>
                <tbody>{sortedTools.map(tool => {
                  const successRate = rateValue(tool.successCount, tool.errorCount)
                  const key = toolKey(tool.sourceIds, tool.nativeToolName)
                  const kind = toolVisualKind(tool.nativeToolName)
                  return <tr key={key} tabIndex={0} onClick={() => { void selectTool(key) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectTool(key) } }}>
                    <td><span className="tool-table-name"><ToolKindIcon kind={kind}/><span><b className="tool-name">{tool.nativeToolName}</b><span className="tool-source">{sourceLabels(tool.sourceIds)}</span></span></span></td>
                    <td><span className="tool-bar-cell"><span>{tool.callCount}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, tool.callCount / maxCalls * 100)}%` }}/></span></span></td>
                    <td>{tool.sessionCount}</td>
                    <td><span className="tool-rate-cell" data-rate={successRate === null ? 'unknown' : tool.errorCount > 0 ? 'mid' : successRate >= 95 ? 'good' : successRate >= 80 ? 'mid' : 'low'}><span>{rate(tool.successCount, tool.errorCount)}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${successRate ?? 0}%` }}/></span></span></td>
                    <td className={tool.errorCount ? 'cell-danger' : 'cell-muted'}>{tool.errorCount}</td><td>{duration(tool.averageDurationMs, t)}</td>
                  </tr>
                })}</tbody>
              </table> : <div className="tools-empty-state"><EmptyStatePanel
                icon={<UiIcon name="search" size={20}/>}
                title={t('page.emptyTitle')}
                description={t('page.emptyDescription')}
                action={canRelaxFilters ? { label: t('page.relaxFilters'), onClick: relaxFilters } : { label: t('page.refresh'), onClick: () => void model.refreshUsage() }}
                compact
              /></div>}
            </div>
          </section>

          {(mostErrors || slowest) && <section className="tool-attention">
            <div className="section-heading-row"><div><h3>{t('page.attention')}</h3><p>{t('page.attentionDescription')}</p></div></div>
            <div className="tool-attention-list">
              {mostErrors && <button className="tool-attention-row" onClick={() => { void selectTool(toolKey(mostErrors.sourceIds, mostErrors.nativeToolName)) }}>
                <span className="tool-attention-badge is-danger">{t('page.failureCluster')}</span>
                <span><b>{mostErrors.nativeToolName}</b><small>{t('page.failureSummary', { failures: mostErrors.errorCount, rate: rate(mostErrors.successCount, mostErrors.errorCount) })}</small></span>
                <strong>{t('page.countTimes', { count: mostErrors.errorCount })}</strong>
              </button>}
              {slowest && <button className="tool-attention-row" onClick={() => { void selectTool(toolKey(slowest.sourceIds, slowest.nativeToolName)) }}>
                <span className="tool-attention-badge is-warning">{t('page.slowestBadge')}</span>
                <span><b>{slowest.nativeToolName}</b><small>{t('page.callsAndSessions', { calls: slowest.callCount, sessions: slowest.sessionCount })}</small></span>
                <strong>{duration(slowest.averageDurationMs, t)}</strong>
              </button>}
            </div>
          </section>}

          {assets.length ? <section className="attributed-assets">
            <div className="section-heading-row"><div><h3>{t('page.attributedAssets')}</h3><p>{t('page.attributedAssetsDescription')}</p></div></div>
            <div className="attributed-asset-list">{assets.map(asset => <div key={`${asset.type}:${asset.canonicalName}`} className="attributed-asset"><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type, t)}</span><span title={t('page.attributionMethod', { method: asset.attribution })}>{confidenceLabel(asset.confidence, t)}</span><span className="asset-usage-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, asset.callCount / maxAssetCalls * 100)}%` }}/></span><strong>{asset.callCount}</strong><small>{t('page.times')}</small></div>)}</div>
          </section> : null}
        </>}
      </div>

      {selectedTool && <Drawer
        open
        className="tool-drill-overlay"
        title={<span className="tool-drawer-title"><ToolKindIcon kind={toolVisualKind(selectedTool.nativeToolName)}/>{selectedTool.nativeToolName}</span>}
        description={sourceLabels(selectedTool.sourceIds)}
        onClose={() => setSelectedToolKey(null)}
      >
        <div className="tool-drill-body">
          <div className="tool-drill-grid">
            <div className="tool-drill-stat"><b>{selectedTool.callCount}</b><span>{t('page.callCount')}</span></div>
            <div className="tool-drill-stat"><b>{selectedTool.sessionCount}</b><span>{t('page.involvedSessions')}</span></div>
            <div className="tool-drill-stat"><b>{rate(selectedTool.successCount, selectedTool.errorCount)}</b><span>{t('page.successRate')}</span></div>
            <div className="tool-drill-stat"><b className={selectedTool.errorCount ? 'cell-danger' : ''}>{selectedTool.errorCount}</b><span>{t('page.failureCount')}</span></div>
            <div className="tool-drill-stat"><b>{duration(selectedTool.totalDurationMs, t)}</b><span>{t('page.totalDuration')}</span></div>
            <div className="tool-drill-stat"><b>{duration(selectedTool.averageDurationMs, t)}</b><span>{t('page.averageDuration')}</span></div>
          </div>

          {firstFailedSession && <button type="button" className="tool-failure-shortcut" onClick={() => openReviewSession(firstFailedSession.logicalSessionId)}>
            <span><b>{t('page.failureScene')}</b><small>{firstFailedSession.title ?? t('page.sessionFallback', { id: shortSessionId(firstFailedSession.logicalSessionId) })} · {t('page.toolFailureCount', { count: firstFailedSession.errorCount })}</small></span>
            <UiIcon name="arrow-right" size={16}/>
          </button>}

          <section className="tool-session-section">
            <div className="table-section-head"><div><h2>{t('page.relatedSessions')}</h2><p>{t('page.relatedDescription')}</p></div></div>
            <div className="tool-session-list">
              {detailLoadingKey === selectedToolKey && <div className="tool-drill-note">{t('page.loadingSessions')}</div>}
              {detailError && detailLoadingKey !== selectedToolKey && <div className="tool-drill-note">{t('page.loadingSessionsFailed', { error: detailError })}</div>}
              {detailLoadingKey !== selectedToolKey && (showAllSessions ? selectedSessions : selectedSessions.slice(0, 3)).map(session => {
                const summary = sessionSummaries.get(session.logicalSessionId)
                const label = session.title ?? summary?.title ?? summary?.preview ?? t('page.sessionFallback', { id: shortSessionId(session.logicalSessionId) })
                const max = Math.max(1, ...selectedSessions.map(item => item.callCount))
                const project = session.projectName ?? summary?.projectName ?? session.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? summary?.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1)
                const time = formatSessionTime(session.endedAt ?? summary?.endedAt, locale)
                const context = [project, time, t('page.sessionCalls', { count: session.callCount }), (session.errorCount ?? 0) > 0 ? t('page.sessionFailures', { count: session.errorCount }) : ''].filter(Boolean).join(' · ')
                return <button key={session.logicalSessionId} className={`tool-session-link ${(session.errorCount ?? 0) > 0 ? 'has-error' : ''}`} onClick={() => openReviewSession(session.logicalSessionId)} title={label}>
                  <span className="tool-session-copy"><b>{label}</b><small>{context || sourceLabels(summary?.sourceIds ?? selectedTool.sourceIds)}</small></span>
                  <span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(5, session.callCount / max * 100)}%` }}/></span>
                  <span className="tool-session-open">{(session.errorCount ?? 0) > 0 ? t('page.viewFailure') : t('page.open')} <UiIcon name="arrow-right" size={14}/></span>
                </button>
              })}
              {detailLoadingKey !== selectedToolKey && !detailError && !selectedSessions.length && <div className="tool-drill-note">{t('page.noLocatableSessions')}</div>}
            </div>
            {detailLoadingKey !== selectedToolKey && selectedSessions.length > 3 && <button type="button" className="tool-session-toggle" onClick={() => setShowAllSessions(value => !value)}>{showAllSessions ? t('page.collapseSessions') : t('page.showAllSessions', { count: selectedSessions.length })}</button>}
          </section>
          {detailLoadingKey !== selectedToolKey && selectedTool.errorCount > 0 && !firstFailedSession && <div className="tool-drill-note">{t('page.boundedFailureNote', { count: selectedTool.errorCount })}</div>}
        </div>
      </Drawer>}
    </main>
  </>
}
