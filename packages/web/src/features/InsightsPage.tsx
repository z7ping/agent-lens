import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type { InsightMetricDeltaDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { InsightsClientModel } from '../client/insights-model'
import { useClientSnapshot } from '../App'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { BackgroundDataNotice } from '../components/BackgroundDataNotice'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { IconButton, SelectMenu, UiIcon } from '../components/ui'

function duration(ms: number, t: TFunction): string {
  if (ms < 1000) return t('duration.milliseconds', { value: ms })
  if (ms < 60_000) return t('duration.seconds', { value: (ms / 1000).toFixed(1) })
  if (ms < 3_600_000) return t('duration.minutes', { value: (ms / 60_000).toFixed(1) })
  return t('duration.hours', { value: (ms / 3_600_000).toFixed(1) })
}

function deltaLabel(value: number | null, t: TFunction): string {
  if (value === null) return t('delta.noBaseline')
  if (value === 0) return t('delta.flat')
  return t(value > 0 ? 'delta.increase' : 'delta.decrease', { value: Math.abs(value) })
}

function deltaClass(value: number | null): string {
  if (value === null || value === 0) return 'neutral'
  return 'changed'
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }) : value
}

function formatGeneratedAt(value: string, locale: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : value
}

function rangeLabel(
  range: 'today' | '7d' | '30d' | 'all',
  t: TFunction,
  locale: string,
  from?: string,
  to?: string,
): string {
  const label = range === 'today'
    ? t('range.today')
    : range === '7d'
      ? t('range.sevenDays')
      : range === '30d'
        ? t('range.thirtyDays')
        : t('range.all')
  if (from && to) return t('range.fromTo', { label, from: formatDate(from, locale), to: formatDate(to, locale) })
  if (from) return t('range.fromNow', { label, from: formatDate(from, locale) })
  if (to) return t('range.until', { label, to: formatDate(to, locale) })
  return label
}

function assetTypeLabel(type: string, t: TFunction): string {
  if (type === 'skill') return t('assetType.skill')
  if (type === 'mcp') return t('assetType.mcp')
  return type
}

function MetricDelta({ label, value }: { label: string; value: number | null }) {
  const { t } = useTranslation('insights')
  return <div className="insight-comparison-item"><span>{label}</span><b className={deltaClass(value)}>{deltaLabel(value, t)}</b></div>
}

export function InsightsPage({ model, sidebarHost }: { model: AgentLensClientModel; sidebarHost?: HTMLDivElement | null }) {
  const { t, i18n } = useTranslation('insights')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const appSnapshot = useClientSnapshot(model)
  const insightsModel = useMemo(() => new InsightsClientModel(), [])
  const insights = useSyncExternalStore(insightsModel.subscribe, insightsModel.getSnapshot, insightsModel.getSnapshot)

  useEffect(() => {
    void insightsModel.start()
    return () => insightsModel.stop()
  }, [insightsModel])

  const data = insights.response
  const agents = useOrderedAgents(appSnapshot.facets?.agents ?? [])
  const insightAgents = useOrderedAgents(data?.agents ?? [])
  const projects = appSnapshot.facets?.projects ?? []
  const agentSelectionSummary = insights.filters.sourceIds === null
    ? t('filters.allAgents')
    : insights.filters.sourceIds.length
      ? t('filters.selectedAgents', { count: insights.filters.sourceIds.length })
      : t('filters.none')
  const maxTrendSessions = Math.max(1, ...(data?.trend.map(item => item.sessionCount) ?? [1]))
  const canRelaxFilters = Boolean(insights.filters.sourceIds !== null || insights.filters.projectId || insights.filters.range !== 'all')
  const hasSseBanner = Boolean(appSnapshot.health && !appSnapshot.liveConnected)
  const comparison = data?.comparison
  const delta: InsightMetricDeltaDto | undefined = comparison?.delta
  const boundedRange = insights.filters.range !== 'all'

  const relaxFilters = () => insightsModel.setFilters({ sourceIds: null, projectId: '', range: 'all' })
  const projectFilterOptions = [
    { value: '', label: t('filters.allProjects') },
    ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
  ]
  const sidebarFilters = <div className="workspace-context-menu workspace-insight-context" aria-label={t('filters.aria')}>
    <div className="workspace-context-utility">
      <span>{agentSelectionSummary}</span>
      <IconButton size="small" onClick={() => void insightsModel.refresh()} title={t('filters.refresh')} aria-label={t('filters.refresh')}><UiIcon name="refresh" size={14}/></IconButton>
    </div>
    <SidebarFilterDisclosure className="workspace-insight-filter-disclosure" summaryMeta={agentSelectionSummary} agents={agents} agentSelection={{ mode: 'multiple', value: insights.filters.sourceIds, onChange: sourceIds => insightsModel.setFilters({ sourceIds }) }}>
      <div className="workspace-insight-filter-fields">
        <label><span>{t('filters.project')}</span><SelectMenu variant="field" value={insights.filters.projectId} onChange={projectId => insightsModel.setFilters({ projectId })} ariaLabel={t('filters.projectAria')} placeholder={t('filters.allProjects')} menuWidth={280} searchable searchPlaceholder={t('filters.searchProject')} options={projectFilterOptions}/></label>
        <label><span>{t('filters.time')}</span><SelectMenu variant="field" value={insights.filters.range} onChange={range => insightsModel.setFilters({ range: range as typeof insights.filters.range })} ariaLabel={t('filters.timeAria')} menuWidth={156} options={[
          { value: 'today', label: t('range.today') }, { value: '7d', label: t('range.sevenDays') }, { value: '30d', label: t('range.thirtyDays') }, { value: 'all', label: t('range.all') },
        ]}/></label>
      </div>
    </SidebarFilterDisclosure>
  </div>

  return <>
    {sidebarHost ? createPortal(sidebarFilters, sidebarHost) : null}
    <main className="workspace-page insights-page">
      <div className="page-content insights-content">
        <CompactPageHeading title={t('page.title')} description={t('page.description')}/>

        {insights.error && <ErrorStateBanner message={insights.error} onRetry={() => void insightsModel.refresh()}/>} 

        {insights.loading && !data ? <WorkspaceSkeleton kind="table"/> : data && data.summary.sessionCount > 0 ? <>
          <section className="insight-coverage-strip" aria-label={t('page.coverageAria')}>
            <div><span>{t('page.statisticsRange')}</span><b>{rangeLabel(insights.filters.range, t, locale, data.meta.from, data.meta.to)}</b></div>
            <div><span>{t('page.sessionSample')}</span><b>{t('page.sessionCount', { count: data.summary.sessionCount })}</b></div>
            <div><span>{t('page.coverageStatus')}</span><b className={data.meta.sampled ? 'is-warning' : ''}>{data.meta.sampled ? t('page.safeSample', { count: data.meta.sessionSampleLimit }) : t('page.fullAggregation')}</b></div>
            <div><span>{t('page.generatedAt')}</span><b>{formatGeneratedAt(data.meta.generatedAt, locale)}</b></div>
          </section>

          <section className="insight-kpi-grid">
            <div className="insight-kpi"><span>{t('page.sessions')}</span><strong>{data.summary.sessionCount}</strong><small>{comparison ? t('page.comparedPrevious', { delta: deltaLabel(delta?.sessionCountPercent ?? null, t) }) : t('page.currentRange')}</small></div>
            <div className="insight-kpi"><span>{t('page.interactions')}</span><strong>{data.summary.interactionCount}</strong><small>{comparison ? t('page.comparedPrevious', { delta: deltaLabel(delta?.interactionCountPercent ?? null, t) }) : t('page.normalizedInteractions')}</small></div>
            <div className="insight-kpi"><span>{t('page.toolCalls')}</span><strong>{data.summary.toolCallCount}</strong><small>{comparison ? t('page.comparedPrevious', { delta: deltaLabel(delta?.toolCallCountPercent ?? null, t) }) : t('page.observedCallsOnly')}</small></div>
            <div className="insight-kpi"><span>{t('page.explicitFailures')}</span><strong>{data.summary.errorCount}</strong><small>{t('page.failureDuration', { duration: duration(data.summary.totalDurationMs, t) })}</small></div>
          </section>

          <section className="insight-grid insight-grid-main">
            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.trendTitle')}</h2><p>{boundedRange ? t('page.trendBounded') : t('page.trendAll')}</p></div></div>
              <div className="insight-trend" role="img" aria-label={t('page.trendAria')}>
                {data.trend.map(point => <div key={point.date} className="insight-trend-column" title={t('page.trendPoint', { date: point.date, sessions: point.sessionCount, calls: point.toolCallCount })}>
                  <div className="insight-trend-bar-wrap"><span className="insight-trend-bar" style={{ height: `${Math.max(point.sessionCount ? 8 : 1, point.sessionCount / maxTrendSessions * 100)}%` }}/></div>
                  <strong>{point.sessionCount}</strong>
                  <span>{point.date.slice(5)}</span>
                </div>)}
              </div>
            </article>

            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.comparisonTitle')}</h2><p>{comparison ? t('page.comparisonDescription') : data.meta.sampled && boundedRange ? t('page.comparisonSampled') : t('page.comparisonHint')}</p></div></div>
              {comparison ? <div className="insight-comparison-grid">
                <MetricDelta label={t('page.sessions')} value={delta?.sessionCountPercent ?? null}/>
                <MetricDelta label={t('page.interactions')} value={delta?.interactionCountPercent ?? null}/>
                <MetricDelta label={t('page.toolCalls')} value={delta?.toolCallCountPercent ?? null}/>
                <MetricDelta label={t('page.explicitFailures')} value={delta?.errorCountPercent ?? null}/>
                <MetricDelta label={t('page.sessionDurationTotal')} value={delta?.totalDurationMsPercent ?? null}/>
                <div className="insight-comparison-item"><span>{t('page.previousSessions')}</span><b className="neutral">{comparison.previous.sessionCount}</b></div>
              </div> : <div className="insight-inline-empty">{data.meta.sampled && boundedRange ? t('page.comparisonSampledEmpty') : t('page.comparisonAllEmpty')}</div>}
            </article>
          </section>

          <section className="insight-card">
            <div className="insight-card-head"><div><h2>{t('page.agentStructureTitle')}</h2><p>{t('page.agentStructureDescription')}</p></div></div>
            <div className="insight-agent-table-wrap"><table className="insight-agent-table">
              <thead><tr><th>{t('page.agent')}</th><th>{t('page.sessions')}</th><th>{t('page.interactions')}</th><th>{t('page.toolCalls')}</th><th>{t('page.explicitFailures')}</th><th>{t('page.observedAssetCalls')}</th><th>{t('page.sessionDurationTotal')}</th></tr></thead>
              <tbody>{insightAgents.map(agent => <tr key={agent.sourceId}><td><b>{agentLabel(agent.sourceId)}</b></td><td>{agent.sessionCount}</td><td>{agent.interactionCount}</td><td>{agent.toolCallCount}</td><td>{agent.errorCount}</td><td>{agent.observedAssetCallCount}</td><td>{duration(agent.totalDurationMs, t)}</td></tr>)}</tbody>
            </table></div>
          </section>

          <section className="insight-grid">
            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.assetAdoptionTitle')}</h2><p>{t('page.assetAdoptionDescription')}</p></div></div>
              {data.assets.length ? <div className="insight-asset-list">{data.assets.slice(0, 12).map(asset => <div className="insight-asset-row" key={`${asset.type}:${asset.canonicalName}`}>
                <div><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type, t)} · {asset.sourceIds.map(sourceId => agentLabel(sourceId)).join(' / ')}</span></div><strong>{asset.callCount}<small> {t('page.times')}</small></strong>
              </div>)}</div> : <div className="insight-inline-empty">{t('page.assetAdoptionEmpty')}</div>}
            </article>

            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.workflowTitle')}</h2><p>{t('page.workflowDescription', { count: data.meta.workflowPatternMinimumSessions })}</p></div></div>
              {data.workflowPatterns.length ? <div className="insight-pattern-list">{data.workflowPatterns.map(pattern => <div className="insight-pattern" key={pattern.key}>
                <div className="insight-pattern-steps">{pattern.steps.map((step, index) => <span key={`${pattern.key}:${index}`}><b>{step}</b>{index < pattern.steps.length - 1 && <i><UiIcon name="arrow-right" size={14}/></i>}</span>)}</div>
                <div className="insight-pattern-meta"><strong>{t('page.workflowSessions', { count: pattern.sessionCount })}</strong><span>{t('page.workflowOccurrences', { count: pattern.occurrenceCount })}</span><span>{t('page.workflowSamples', { count: pattern.observationIds.length })}</span></div>
              </div>)}</div> : <div className="insight-inline-empty">{t('page.workflowEmpty', { count: data.meta.workflowPatternMinimumSessions })}</div>}
            </article>
          </section>

          <section className="insight-method-note">
            <b>{t('page.methodology')}</b>
            {data.meta.notes.map(note => <span key={note}>{note}</span>)}
            {data.meta.sampled && <span className="is-warning">{t('page.sampledWarning', { count: data.meta.sessionSampleLimit })}</span>}
          </section>
        </> : <div className="insight-empty-wrap"><EmptyStatePanel
          icon={<UiIcon name="trend" size={20}/>}
          title={t('page.emptyTitle')}
          description={t('page.emptyDescription')}
          action={canRelaxFilters ? { label: t('page.relaxFilters'), onClick: relaxFilters } : { label: t('page.refresh'), onClick: () => void insightsModel.refresh() }}
        /></div>}
      </div>

      {insights.hasNewData && <BackgroundDataNotice label={t('page.title')} hasSseBanner={hasSseBanner} onRefresh={() => insightsModel.refresh()}/>} 
    </main>
  </>
}
