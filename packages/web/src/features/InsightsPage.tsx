import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { InsightMetricDeltaDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { InsightsClientModel } from '../client/insights-model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel } from '../components/AgentScope'
import { BackgroundDataNotice } from '../components/BackgroundDataNotice'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { SelectMenu } from '../components/SelectMenu'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'
import { UiIcon } from '../components/UiIcon'

function duration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} 分钟`
  return `${(ms / 3_600_000).toFixed(1)} 小时`
}

function deltaLabel(value: number | null): string {
  if (value === null) return '无可比基线'
  if (value === 0) return '持平'
  return `${value > 0 ? '增加' : '减少'} ${Math.abs(value)}%`
}

function deltaClass(value: number | null): string {
  if (value === null || value === 0) return 'neutral'
  return 'changed'
}

function formatDate(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : value
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : value
}

function assetTypeLabel(type: string): string {
  if (type === 'skill') return '技能'
  if (type === 'mcp') return 'MCP（模型上下文协议）'
  return type
}

function MetricDelta({ label, value }: { label: string; value: number | null }) {
  return <div className="insight-comparison-item"><span>{label}</span><b className={deltaClass(value)}>{deltaLabel(value)}</b></div>
}

export function InsightsPage({ model }: { model: AgentLensClientModel }) {
  const appSnapshot = useClientSnapshot(model)
  const insightsModel = useMemo(() => new InsightsClientModel(), [])
  const insights = useSyncExternalStore(insightsModel.subscribe, insightsModel.getSnapshot, insightsModel.getSnapshot)

  useEffect(() => {
    void insightsModel.start()
    return () => insightsModel.stop()
  }, [insightsModel])

  const data = insights.response
  const agents = appSnapshot.facets?.agents ?? []
  const projects = appSnapshot.facets?.projects ?? []
  const maxTrendSessions = Math.max(1, ...(data?.trend.map(item => item.sessionCount) ?? [1]))
  const canRelaxFilters = Boolean(insights.filters.sourceId || insights.filters.projectId || insights.filters.range !== 'all')
  const hasSseBanner = Boolean(appSnapshot.health && !appSnapshot.liveConnected)
  const comparison = data?.comparison
  const delta: InsightMetricDeltaDto | undefined = comparison?.delta
  const boundedRange = insights.filters.range !== 'all'

  const relaxFilters = () => insightsModel.setFilters({ sourceId: '', projectId: '', range: 'all' })

  return <main className="workspace-page insights-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={insights.filters.sourceId} onChange={sourceId => insightsModel.setFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <SelectMenu className="filter" value={insights.filters.projectId} onChange={projectId => insightsModel.setFilters({ projectId })} ariaLabel="筛选项目" placeholder="全部项目" menuWidth={280} searchable searchPlaceholder="搜索项目" options={[
        { value: '', label: '全部项目' },
        ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
      ]}/>
      <SelectMenu className="filter" value={insights.filters.range} onChange={range => insightsModel.setFilters({ range: range as typeof insights.filters.range })} ariaLabel="筛选时间范围" menuWidth={156} options={[
        { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }, { value: 'all', label: '全部时间' },
      ]}/>
      <button className="icon-button toolbar-end" onClick={() => void insightsModel.refresh()} title="刷新使用洞察" aria-label="刷新使用洞察"><UiIcon name="refresh" size={15}/></button>
    </div>

    <div className="page-content insights-content">
      <CompactPageHeading title="使用洞察" description="聚合已采集的会话、工具和能力资产事实，观察趋势与重复模式。这里只呈现可验证事实，不做智能体综合评分，也不把共同出现解释成因果关系。"/>

      {insights.error && <ErrorStateBanner message={insights.error} onRetry={() => void insightsModel.refresh()}/>} 

      {insights.loading && !data ? <WorkspaceSkeleton kind="table"/> : data && data.summary.sessionCount > 0 ? <>
        <section className="insight-coverage-strip" aria-label="洞察统计覆盖范围">
          <div><span>统计范围</span><b>{data.meta.from && data.meta.to ? `${formatDate(data.meta.from)} — ${formatDate(data.meta.to)}` : '全部已载入历史'}</b></div>
          <div><span>会话样本</span><b>{data.summary.sessionCount} 个</b></div>
          <div><span>覆盖状态</span><b className={data.meta.sampled ? 'is-warning' : ''}>{data.meta.sampled ? `最近 ${data.meta.sessionSampleLimit} 个以内的安全样本` : '当前范围完整聚合'}</b></div>
          <div><span>生成时间</span><b>{formatGeneratedAt(data.meta.generatedAt)}</b></div>
        </section>

        <section className="insight-kpi-grid">
          <div className="insight-kpi"><span>会话</span><strong>{data.summary.sessionCount}</strong><small>{comparison ? `较上周期 ${deltaLabel(delta?.sessionCountPercent ?? null)}` : '当前筛选范围'}</small></div>
          <div className="insight-kpi"><span>交互轮次</span><strong>{data.summary.interactionCount}</strong><small>{comparison ? `较上周期 ${deltaLabel(delta?.interactionCountPercent ?? null)}` : '按规范交互聚合'}</small></div>
          <div className="insight-kpi"><span>工具调用</span><strong>{data.summary.toolCallCount}</strong><small>{comparison ? `较上周期 ${deltaLabel(delta?.toolCallCountPercent ?? null)}` : '只统计已观察调用'}</small></div>
          <div className="insight-kpi"><span>明确失败</span><strong>{data.summary.errorCount}</strong><small>仅统计结果明确标记失败的工具调用 · 会话跨度合计 {duration(data.summary.totalDurationMs)}</small></div>
        </section>

        <section className="insight-grid insight-grid-main">
          <article className="insight-card">
            <div className="insight-card-head"><div><h2>使用趋势</h2><p>{boundedRange ? '按会话结束日期聚合；当前固定时间窗内的空白日期保留为 0。' : '按会话结束日期聚合；全部时间视图只显示实际存在会话的日期。'}</p></div></div>
            <div className="insight-trend" role="img" aria-label="按日期统计的会话趋势">
              {data.trend.map(point => <div key={point.date} className="insight-trend-column" title={`${point.date}：${point.sessionCount} 个会话，${point.toolCallCount} 次工具调用`}>
                <div className="insight-trend-bar-wrap"><span className="insight-trend-bar" style={{ height: `${Math.max(point.sessionCount ? 8 : 1, point.sessionCount / maxTrendSessions * 100)}%` }}/></div>
                <strong>{point.sessionCount}</strong>
                <span>{point.date.slice(5)}</span>
              </div>)}
            </div>
          </article>

          <article className="insight-card">
            <div className="insight-card-head"><div><h2>周期变化</h2><p>{comparison ? '当前时间窗与紧邻的等长上一个时间窗比较。' : data.meta.sampled && boundedRange ? '会话已超过当前安全样本上限，上一周期可能不完整，因此不生成比较。' : '选择今天、最近 7 天或最近 30 天后可显示等长周期比较。'}</p></div></div>
            {comparison ? <div className="insight-comparison-grid">
              <MetricDelta label="会话" value={delta?.sessionCountPercent ?? null}/>
              <MetricDelta label="交互轮次" value={delta?.interactionCountPercent ?? null}/>
              <MetricDelta label="工具调用" value={delta?.toolCallCountPercent ?? null}/>
              <MetricDelta label="明确失败" value={delta?.errorCountPercent ?? null}/>
              <MetricDelta label="会话跨度" value={delta?.totalDurationMsPercent ?? null}/>
              <div className="insight-comparison-item"><span>上周期会话</span><b className="neutral">{comparison.previous.sessionCount}</b></div>
            </div> : <div className="insight-inline-empty">{data.meta.sampled && boundedRange ? '保持空白比使用不完整的上一周期样本生成百分比更可靠。' : '全部时间没有天然的“上一等长周期”，因此不强行生成对比。'}</div>}
          </article>
        </section>

        <section className="insight-card">
          <div className="insight-card-head"><div><h2>智能体使用结构</h2><p>同一会话若同时包含多个来源，会分别计入对应智能体；这是“会话中出现过该来源”，不是独占归因。</p></div></div>
          <div className="insight-agent-table-wrap"><table className="insight-agent-table">
            <thead><tr><th>智能体</th><th>会话</th><th>交互</th><th>工具调用</th><th>明确失败</th><th>已观察资产调用</th><th>会话跨度合计</th></tr></thead>
            <tbody>{data.agents.map(agent => <tr key={agent.sourceId}><td><b>{agentLabel(agent.sourceId)}</b></td><td>{agent.sessionCount}</td><td>{agent.interactionCount}</td><td>{agent.toolCallCount}</td><td>{agent.errorCount}</td><td>{agent.observedAssetCallCount}</td><td>{duration(agent.totalDurationMs)}</td></tr>)}</tbody>
          </table></div>
        </section>

        <section className="insight-grid">
          <article className="insight-card">
            <div className="insight-card-head"><div><h2>能力资产采用</h2><p>这里只展示能够可靠从工具名归因到具体技能或 MCP（模型上下文协议）的真实调用；不会把普通命令硬归因到资产。</p></div></div>
            {data.assets.length ? <div className="insight-asset-list">{data.assets.slice(0, 12).map(asset => <div className="insight-asset-row" key={`${asset.type}:${asset.canonicalName}`}>
              <div><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type)} · {asset.sourceIds.map(sourceId => agentLabel(sourceId)).join(' / ')}</span></div><strong>{asset.callCount}<small> 次</small></strong>
            </div>)}</div> : <div className="insight-inline-empty">当前范围没有可可靠归因的技能或 MCP（模型上下文协议）调用。</div>}
          </article>

          <article className="insight-card">
            <div className="insight-card-head"><div><h2>重复工作流模式</h2><p>连续工具类别序列至少出现在 {data.meta.workflowPatternMinimumSessions} 个不同会话后才显示。</p></div></div>
            {data.workflowPatterns.length ? <div className="insight-pattern-list">{data.workflowPatterns.map(pattern => <div className="insight-pattern" key={pattern.key}>
              <div className="insight-pattern-steps">{pattern.steps.map((step, index) => <span key={`${pattern.key}:${index}`}><b>{step}</b>{index < pattern.steps.length - 1 && <i>→</i>}</span>)}</div>
              <div className="insight-pattern-meta"><strong>{pattern.sessionCount} 个会话</strong><span>{pattern.occurrenceCount} 次出现</span><span>{pattern.observationIds.length} 条样本观测</span></div>
            </div>)}</div> : <div className="insight-inline-empty">还没有任何连续工具类别序列跨越至少 {data.meta.workflowPatternMinimumSessions} 个会话。样本不足时保持空白，不提前下结论。</div>}
          </article>
        </section>

        <section className="insight-method-note">
          <b>统计口径</b>
          {data.meta.notes.map(note => <span key={note}>{note}</span>)}
          {data.meta.sampled && <span className="is-warning">会话数量超过一次投影的 {data.meta.sessionSampleLimit} 个样本上限：会话趋势、智能体使用结构和工作流模式只基于最近样本；能力资产采用仍按当前时间筛选汇总可读取的已观察调用；周期比较已关闭。</span>}
        </section>
      </> : <div className="insight-empty-wrap"><EmptyStatePanel
        icon={<UiIcon name="trend" size={20}/>}
        title="当前筛选范围还没有可分析的会话"
        description="使用洞察只基于 AgentLens 已经采集到的真实会话事实。扩大时间范围或清除筛选后再查看。"
        action={canRelaxFilters ? { label: '放宽筛选条件', onClick: relaxFilters } : { label: '刷新', onClick: () => void insightsModel.refresh() }}
      /></div>}
    </div>

    {insights.hasNewData && <BackgroundDataNotice label="使用洞察" hasSseBanner={hasSseBanner} onRefresh={() => insightsModel.refresh()}/>} 
  </main>
}
