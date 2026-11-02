import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type { InsightMetricDeltaDto, NativeMetricOverviewResponseDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { AgentLensApi, rangeStart } from '../client/api'
import { InsightsClientModel } from '../client/insights-model'
import { useClientSnapshotField } from '../client/use-client-snapshot'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { AgentLogo } from '../components/AgentLogo'
import { BackgroundDataNotice } from '../components/BackgroundDataNotice'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'
import { SidebarFilterDisclosure } from '../components/SidebarFilterDisclosure'
import { Button, Disclosure, IconButton, SelectMenu, UiIcon } from '../components/ui'
import { projectSelectOption } from './project-presentation'

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

const radarApi = new AgentLensApi()

export function InsightsPage({ model, toolbarHost }: { model: AgentLensClientModel; toolbarHost?: HTMLDivElement | null }) {
  const { t, i18n } = useTranslation('insights')
  const navigate = useNavigate()
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const facets = useClientSnapshotField(model, 'facets')
  const usage = useClientSnapshotField(model, 'usage')
  const health = useClientSnapshotField(model, 'health')
  const liveConnected = useClientSnapshotField(model, 'liveConnected')
  const insightsModel = useMemo(() => new InsightsClientModel(undefined, model.getSnapshot().usage.filters), [model])
  const insights = useSyncExternalStore(insightsModel.subscribe, insightsModel.getSnapshot, insightsModel.getSnapshot)
  // The radar has its own all-Agent query. Never change the shared single-Agent scope.
  const [radarSnapshot, setRadarSnapshot] = useState<{ key: string; response: NativeMetricOverviewResponseDto } | null>(null)
  const [radarError, setRadarError] = useState<{ key: string; message: string } | null>(null)
  const [radarRefresh, setRadarRefresh] = useState(0)
  const radarScopeKey = JSON.stringify([usage.filters.projectId, usage.filters.range])
  useEffect(() => {
    const controller = new AbortController()
    setRadarError(null)
    void radarApi.nativeMetricsOverview({
      projectId: usage.filters.projectId || undefined,
      from: rangeStart(usage.filters.range),
      signal: controller.signal,
    }).then(
      response => {
        if (!controller.signal.aborted) setRadarSnapshot({ key: radarScopeKey, response })
      },
      reason => {
        if (!controller.signal.aborted) setRadarError({
          key: radarScopeKey,
          message: reason instanceof Error ? reason.message : String(reason),
        })
      },
    )
    return () => controller.abort()
  }, [radarScopeKey, radarRefresh, insights.response?.meta.generatedAt])
  const radar = radarError?.key === radarScopeKey ? null
    : radarSnapshot?.key === radarScopeKey ? radarSnapshot.response : null
  const radarItems = new Map(
    radar?.state === 'available' ? radar.items.map(item => [item.sourceId, item] as const) : [],
  )
  const radarUnavailable = radar?.state === 'unavailable' || radar?.state === 'unsupported'
    || radarError?.key === radarScopeKey
  const refreshInsights = () => {
    setRadarRefresh(value => value + 1)
    void insightsModel.refresh()
  }

  useEffect(() => {
    void insightsModel.start(listener => model.subscribeLiveEvents(listener))
    return () => insightsModel.stop()
  }, [insightsModel, model])

  // Usage is the shared scope owner for both tabs. An insights response is
  // hidden until its filter identity matches, preventing stale cross-Agent totals.
  const matchingScope = usage.filters.sourceIds?.length === 1
    && insights.filters.sourceIds?.length === 1
    && usage.filters.sourceIds[0] === insights.filters.sourceIds[0]
    && usage.filters.projectId === insights.filters.projectId
    && usage.filters.range === insights.filters.range
  useEffect(() => {
    if (!matchingScope) insightsModel.setFilters(usage.filters)
  }, [insightsModel, matchingScope, usage.filters])
  const data = matchingScope ? insights.response : null
  const verifiedNative=data?.meta.native?.state==='available' ? data.meta.native : null
  const nativeTrend=verifiedNative?.trend??[]
  const maxNativeTrendSessions=Math.max(1,...nativeTrend.map(item=>item.sessionCount))
  const agents = useOrderedAgents(facets?.agents ?? [])
  const insightAgents = useOrderedAgents(data?.agents ?? [])
  const projects = facets?.projects ?? []
  const selectedSourceId = usage.filters.sourceIds?.[0] ?? ''
  const selectedAgent = agents.find(agent => agent.sourceId === selectedSourceId)
  const agentSelectionSummary = selectedSourceId
    ? agentLabel(selectedSourceId, selectedAgent?.displayName)
    : t('filters.none')
  const maxTrendSessions = Math.max(1, ...(data?.trend.map(item => item.sessionCount) ?? [1]))
  const canRelaxFilters = Boolean(usage.filters.projectId || usage.filters.range !== 'all')
  const hasSseBanner = Boolean(health && !liveConnected)
  const comparison = data?.comparison
  const delta: InsightMetricDeltaDto | undefined = comparison?.delta
  const boundedRange = insights.filters.range !== 'all'

  const relaxFilters = () => model.setUsageFilters({ projectId: '', range: 'all' })
  const projectFilterOptions = [
    { value: '', label: t('filters.allProjects') },
    ...projects.map(projectSelectOption),
  ]
  const toolbarFilters = <div className="workspace-view-controls" aria-label={t('filters.aria')}>
    <div className="workspace-view-filter">
      <SidebarFilterDisclosure summary={agentSelectionSummary} agents={agents} allowUndetectedSelection agentSelection={{ mode: 'single', value: selectedSourceId, onChange: sourceId => model.setUsageFilters({ sourceIds: [sourceId], projectId: '' }) }}/>
    </div>
    <div className="workspace-view-filter">
      <SelectMenu value={usage.filters.projectId} onChange={projectId => model.setUsageFilters({ projectId })} ariaLabel={t('filters.projectAria')} placeholder={t('filters.allProjects')} searchable searchPlaceholder={t('filters.searchProject')} options={projectFilterOptions}/>
    </div>
    <div className="workspace-view-filter workspace-view-filter-time">
      <SelectMenu value={usage.filters.range} onChange={range => model.setUsageFilters({ range: range as typeof usage.filters.range })} ariaLabel={t('filters.timeAria')} options={[
        { value: 'today', label: t('range.today') }, { value: '7d', label: t('range.sevenDays') }, { value: '30d', label: t('range.thirtyDays') }, { value: 'all', label: t('range.all') },
      ]}/>
    </div>
    <div className="workspace-view-filter-actions">
      {canRelaxFilters && <Button className="workspace-view-clear-filter" onClick={relaxFilters}>{t('page.relaxFilters')}</Button>}
      <IconButton size="small" onClick={refreshInsights} title={t('filters.refresh')} aria-label={t('filters.refresh')}><UiIcon name="refresh" size={14}/></IconButton>
    </div>
  </div>

  return <>
    {toolbarHost ? createPortal(toolbarFilters, toolbarHost) : null}
    <main className="workspace-page insights-page">
      <div className="page-content insights-content">
        {insights.error && <ErrorStateBanner message={insights.error} onRetry={refreshInsights}/>} 
        {data?.meta.mode==='native-only' && data.meta.native?.state!=='available' &&
          <ErrorStateBanner message={t('page.nativeMetricsUnavailable')}
            onRetry={() => void insightsModel.refresh()}/> }

        {agents.length > 0 && <section className="insight-agent-radar" aria-label={t('page.radarTitle')}>
          <div className="insight-agent-radar-head">
            <h2>{t('page.radarTitle')}</h2>
            {radar?.state === 'available'
              ? <span>
                  {t('page.radarCoverage', { ready: radar.totals.readySessions, eligible: radar.totals.eligibleSessions })}
                </span>
              : radarUnavailable
                ? <span className="is-warning" title={radarError?.message || (radar && 'reason' in radar ? radar.reason : '')}>{t('page.radarUnavailable')}</span>
                : <span>{t('page.radarLoading')}</span>}
          </div>
          <div className="insight-agent-radar-grid">
            {agents.map(agent => {
              const metric = radarItems.get(agent.sourceId)
              const verified = metric?.readySessions ? metric.totals.errorCount : null
              const observed = metric?.partialSessions ? metric.observed?.errorCount ?? null : null
              // Each cohort is independent. Lead with its larger known failure count;
              // the other remains visible as secondary context, never a fabricated sum.
              const showObserved = observed !== null && observed > 0 && observed >= (verified ?? 0)
              const primary = showObserved ? `≥${observed}`
                : verified !== null && (verified > 0 || !metric?.partialSessions) ? String(verified)
                  : '—'
              const hasErrors = (verified ?? 0) > 0 || (observed ?? 0) > 0
              const detail = showObserved
                ? verified !== null && verified > 0
                  ? t('page.radarVerified', { count: verified })
                  : t('page.radarObservedLabel')
                : observed !== null && observed > 0
                  ? t('page.radarAdditionalObserved', { count: observed })
                  : observed !== null ? t('page.radarObservedLabel')
                    : verified !== null ? t('page.radarVerifiedLabel')
                      : metric?.eligibleSessions ? t('page.radarPending')
                        : metric ? t('page.radarNoSessions')
                          : radar === null && !radarUnavailable ? t('page.radarLoading') : t('page.radarUnavailable')
              return <Button key={agent.sourceId} variant="tile" className={`insight-agent-radar-item${hasErrors ? ' has-errors' : ''}`}
                aria-pressed={selectedSourceId === agent.sourceId}
                title={metric ? t('page.radarTooltip', {
                  ready: metric.readySessions, eligible: metric.eligibleSessions,
                  verified: metric.totals.errorCount, observed: metric.observed?.errorCount ?? 0,
                }) : t('page.radarUnavailable')}
                onClick={() => model.setUsageFilters({ sourceIds: [agent.sourceId] })}>
                <span className="insight-agent-radar-identity">
                  <AgentLogo sourceId={agent.sourceId} size="compact"/>
                  <span className="insight-agent-radar-name">{agentLabel(agent.sourceId, agent.displayName)}</span>
                  <UiIcon name="chevron-right" size={14} className="insight-agent-radar-arrow"/>
                </span>
                <strong>{primary}</strong>
                <small>{detail}</small>
              </Button>
            })}
          </div>
        </section>}
        {data?.meta.mode === 'native-only' && <div className="insight-detail-heading">
          <h2>{agentSelectionSummary}</h2>
          <Button size="small" variant="quiet" onClick={()=>navigate('/tools?view=failures')}>
            {t('page.failureExamples')}<UiIcon name="chevron-right" size={14}/>
          </Button>
        </div>}
        {data?.meta.native && (data.meta.mode === 'native-only'
          ? <section className="insight-native-coverage" role="status"
              aria-label={t('page.nativeCoverageTitle')}
              title={t(data.meta.mode === 'native-only' ? 'page.nativeOnlyModeNote' : 'page.nativeSeparateNote')}>
              <span>{data.meta.native.state === 'available'
                ? t('page.nativeCoverageCount', { ready: data.meta.native.readySessions,
                  eligible: data.meta.native.eligibleSessions })
                : t('page.nativeCoverageUnavailable')}</span>
              {data.meta.native.state === 'available' && data.meta.native.partialSessions > 0 &&
                <span className="is-warning">{t('page.radarPartialSessions', { count: data.meta.native.partialSessions })}</span>}
            </section>
          : <section className="insight-coverage-strip" role="status"
              aria-label={t('page.nativeCoverageTitle')}>
              <div><span>{t('page.nativeCoverageTitle')}</span><b>{data.meta.native.state === 'available'
                ? t('page.nativeCoverageCount', { ready: data.meta.native.readySessions,
                  eligible: data.meta.native.eligibleSessions })
                : t('page.nativeCoverageUnavailable')}</b></div>
              {data.meta.native.state === 'available' && <>
                <div><span>{t('page.nativeObservedSessions')}</span><b>{data.meta.native.partialSessions}</b></div>
                <div><span>{t('page.nativeCoverageStatus')}</span>
                  <b className={data.meta.native.coverage === 'partial' ? 'is-warning' : ''}
                    title={t('page.nativeSeparateNote')}>
                    {data.meta.native.coverage === 'partial'
                      ? t('page.nativePartialCoverage') : t('page.nativeCompleteCoverage')}</b></div>
              </>}
            </section>)}

        {insights.loading && !data ? <WorkspaceSkeleton kind="insights"/> : data?.meta.mode==='native-only' ? <>
          {verifiedNative && verifiedNative.readySessions > 0 && <section className="insight-kpi-grid is-native"
            aria-label={t('page.nativeCoverageTitle')}>
            <div className="workspace-metric-card insight-kpi">
              <span>{t('page.interactions')}</span>
              <strong>{verifiedNative.interactionCount}</strong>
            </div>
            <button type="button" className="workspace-metric-card insight-kpi insight-kpi-action"
              onClick={()=>navigate('/tools')} title={t('page.toolCalls')}>
              <span>{t('page.toolCalls')}<UiIcon name="chevron-right" size={14}/></span>
              <strong>{verifiedNative.toolCallCount}</strong>
            </button>
            <button type="button" className="workspace-metric-card insight-kpi insight-kpi-action is-failure"
              onClick={()=>navigate('/tools?view=failures')} title={t('page.failureExamples')}>
              <span>{t('page.explicitFailures')}<UiIcon name="chevron-right" size={14}/></span>
              <strong>{verifiedNative.errorCount}</strong>
            </button>
          </section>}
          {nativeTrend.length>0 && <section className="insight-card">
            <div className="insight-card-head insight-native-trend-heading">
              <h2>{t('page.nativeTrendTitle')}</h2>
              <span title={t('page.nativeTrendDescription')}>{t('page.nativeTrendBasis')}</span>
            </div>
            <div className="insight-trend" role="img" aria-label={t('page.nativeTrendTitle')}>
              {nativeTrend.map(point=><div key={point.date} className="insight-trend-column"
                title={t('page.nativeTrendPoint',{date:point.date,sessions:point.sessionCount,calls:point.toolCallCount})}>
                <div className="insight-trend-bar-wrap"><span className="insight-trend-bar"
                  style={{height:`${Math.max(point.sessionCount?8:1,point.sessionCount/maxNativeTrendSessions*100)}%`}}/></div>
                <strong>{point.sessionCount}</strong><span>{point.date.slice(5)}</span>
              </div>)}
            </div>
          </section>}
          {verifiedNative?.observed && <section className="insight-kpi-grid is-native"
            aria-label={t('page.nativeObservedTitle')}>
            <div className="workspace-metric-card insight-kpi">
              <span>{t('page.nativeObservedInteractions')}</span>
              <strong>≥{verifiedNative.observed.interactionCount}</strong>
            </div>
            <div className="workspace-metric-card insight-kpi">
              <span>{t('page.nativeObservedCalls')}</span>
              <strong>≥{verifiedNative.observed.toolCallCount}</strong>
            </div>
            <div className="workspace-metric-card insight-kpi">
              <span>{t('page.nativeObservedErrors')}</span>
              <strong>≥{verifiedNative.observed.errorCount}</strong>
            </div>
          </section>}
        </> : data && data.summary.sessionCount > 0 ? <>
          <section className="insight-coverage-strip" aria-label={t('page.coverageAria')}>
            <div><span>{t('page.statisticsRange')}</span><b>{rangeLabel(usage.filters.range, t, locale, data.meta.from, data.meta.to)}</b></div>
            <div><span>{t('page.sessionSample')}</span><b>{t('page.sessionCount', { count: data.summary.sessionCount })}</b></div>
            <div><span>{t('page.coverageStatus')}</span><b className={data.meta.sampled ? 'is-warning' : ''}>{data.meta.sampled ? t('page.safeSample', { count: data.meta.sessionSampleLimit }) : t('page.fullAggregation')}</b></div>
            <div><span>{t('page.generatedAt')}</span><b>{formatGeneratedAt(data.meta.generatedAt, locale)}</b></div>
          </section>

          <section className="insight-kpi-grid">
            <div className="workspace-metric-card insight-kpi"><span>{t('page.sessions')}</span><strong>{data.summary.sessionCount}</strong>{comparison && <small>{t('page.comparedPrevious', { delta: deltaLabel(delta?.sessionCountPercent ?? null, t) })}</small>}</div>
            <div className="workspace-metric-card insight-kpi"><span>{t('page.interactions')}</span><strong>{data.summary.interactionCount}</strong>{comparison && <small>{t('page.comparedPrevious', { delta: deltaLabel(delta?.interactionCountPercent ?? null, t) })}</small>}</div>
            <div className="workspace-metric-card insight-kpi"><span>{t('page.toolCalls')}</span><strong>{data.summary.toolCallCount}</strong>{comparison && <small>{t('page.comparedPrevious', { delta: deltaLabel(delta?.toolCallCountPercent ?? null, t) })}</small>}</div>
            <div className="workspace-metric-card insight-kpi"><span>{t('page.explicitFailures')}</span><strong>{data.summary.errorCount}</strong>{comparison && <small>{t('page.comparedPrevious', { delta: deltaLabel(delta?.errorCountPercent ?? null, t) })}</small>}</div>
          </section>

          <section className="insight-grid insight-grid-main">
            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.trendTitle')}</h2></div></div>
              <div className="insight-trend" role="img" aria-label={t('page.trendAria')}>
                {data.trend.map(point => <div key={point.date} className="insight-trend-column" title={t('page.trendPoint', { date: point.date, sessions: point.sessionCount, calls: point.toolCallCount })}>
                  <div className="insight-trend-bar-wrap"><span className="insight-trend-bar" style={{ height: `${Math.max(point.sessionCount ? 8 : 1, point.sessionCount / maxTrendSessions * 100)}%` }}/></div>
                  <strong>{point.sessionCount}</strong>
                  <span>{point.date.slice(5)}</span>
                </div>)}
              </div>
            </article>

            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.comparisonTitle')}</h2></div></div>
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
            <div className="insight-card-head"><div><h2>{t('page.agentStructureTitle')}</h2></div></div>
            <div className="insight-agent-table-wrap"><table className="insight-agent-table">
              <thead><tr><th>{t('page.agent')}</th><th>{t('page.sessions')}</th><th>{t('page.interactions')}</th><th>{t('page.toolCalls')}</th><th>{t('page.explicitFailures')}</th><th>{t('page.observedAssetCalls')}</th><th>{t('page.sessionDurationTotal')}</th></tr></thead>
              <tbody>{insightAgents.map(agent => <tr key={agent.sourceId}><td><b>{agentLabel(agent.sourceId)}</b></td><td>{agent.sessionCount}</td><td>{agent.interactionCount}</td><td>{agent.toolCallCount}</td><td>{agent.errorCount}</td><td>{agent.observedAssetCallCount}</td><td>{duration(agent.totalDurationMs, t)}</td></tr>)}</tbody>
            </table></div>
          </section>

          <section className="insight-grid">
            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.assetAdoptionTitle')}</h2></div></div>
              {data.assets.length ? <div className="insight-asset-list">{data.assets.slice(0, 12).map(asset => <div className="insight-asset-row" key={`${asset.type}:${asset.canonicalName}`}>
                <div><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type, t)} · {asset.sourceIds.map(sourceId => agentLabel(sourceId)).join(' / ')}</span></div><strong>{asset.callCount}<small> {t('page.times')}</small></strong>
              </div>)}</div> : <div className="insight-inline-empty">{t('page.assetAdoptionEmpty')}</div>}
            </article>

            <article className="insight-card">
              <div className="insight-card-head"><div><h2>{t('page.workflowTitle')}</h2></div><span>≥ {t('page.workflowSessions', { count: data.meta.workflowPatternMinimumSessions })}</span></div>
              {data.workflowPatterns.length ? <div className="insight-pattern-list">{data.workflowPatterns.map(pattern => <div className="insight-pattern" key={pattern.key}>
                <div className="insight-pattern-steps">{pattern.steps.map((step, index) => <span key={`${pattern.key}:${index}`}><b>{step}</b>{index < pattern.steps.length - 1 && <i><UiIcon name="arrow-right" size={14}/></i>}</span>)}</div>
                <div className="insight-pattern-meta"><strong>{t('page.workflowSessions', { count: pattern.sessionCount })}</strong><span>{t('page.workflowOccurrences', { count: pattern.occurrenceCount })}</span><span>{t('page.workflowSamples', { count: pattern.observationIds.length })}</span></div>
              </div>)}</div> : <div className="insight-inline-empty">{t('page.workflowEmpty', { count: data.meta.workflowPatternMinimumSessions })}</div>}
            </article>
          </section>

          {data.meta.sampled && <section className="insight-method-note is-warning">
            <span>{t('page.sampledWarning', { count: data.meta.sessionSampleLimit })}</span>
          </section>}
          {data.meta.notes.length > 0 && <Disclosure className="disclosure-group insight-method-disclosure" summary={t('page.methodology')}>
            <div className="insight-method-note">{data.meta.notes.map(note => <span key={note}>{note}</span>)}</div>
          </Disclosure>}
        </> : <div className="insight-empty-wrap"><EmptyStatePanel
          icon={<UiIcon name="trend" size={20}/>}
          title={data?.meta.native?.state === 'available'
            && data.meta.native.eligibleSessions > 0
            ? t('page.nativeOnlyEmptyTitle') : t('page.emptyTitle')}
          description={data?.meta.native?.state === 'available'
            && data.meta.native.eligibleSessions > 0
            ? t('page.nativeOnlyEmptyDescription') : t('page.emptyDescription')}
          action={canRelaxFilters ? { label: t('page.relaxFilters'), onClick: relaxFilters } : { label: t('page.refresh'), onClick: () => void insightsModel.refresh() }}
        /></div>}
      </div>

      {insights.hasNewData && <BackgroundDataNotice label={t('page.title')} hasSseBanner={hasSseBanner} onRefresh={() => insightsModel.refresh()}/>} 
    </main>
  </>
}
