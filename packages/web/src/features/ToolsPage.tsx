import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ToolUsageDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel } from '../components/AgentScope'
import { CompactPageHeading } from '../components/CompactPageHeading'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'
import { ToolKindIcon, toolVisualKind } from '../components/ToolKindIcon'
import { Drawer, IconButton, SelectMenu, Toolbar } from '../components/ui'
import { UiIcon } from '../components/UiIcon'

function duration(ms: number): string {
  if (ms <= 0) return '未观察到'
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

function rateValue(success: number, error: number): number | null {
  const total = success + error
  return total ? Math.round(success / total * 100) : null
}

function rate(success: number, error: number): string {
  const total = success + error
  return total ? `${rateValue(success, error)}%` : '—'
}

function assetTypeLabel(type: string): string {
  if (type === 'skill') return '技能'
  if (type === 'mcp') return 'MCP（模型上下文协议）'
  return '其他'
}

function confidenceLabel(confidence: string): string {
  if (confidence === 'high') return '高可信'
  if (confidence === 'medium') return '中可信'
  if (confidence === 'low') return '低可信'
  return '可信度未知'
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

type SortKey = 'callCount' | 'sessionCount' | 'successRate' | 'errorCount' | 'averageDurationMs'
type SortDirection = 'ascending' | 'descending'

function sortMetric(tool: ToolUsageDto, key: SortKey): number {
  if (key === 'successRate') return rateValue(tool.successCount, tool.errorCount) ?? -1
  return tool[key]
}

export function ToolsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const navigate = useNavigate()
  const usage = snapshot.usage
  const data = usage.response
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
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
  const canRelaxFilters = Boolean(usage.filters.sourceId || usage.filters.projectId || usage.filters.range !== 'all')
  const blockingError = Boolean(usage.error && !data)
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'callCount', direction: 'descending' })
  const selectedTool = useMemo(() => tools.find(tool => toolKey(tool.sourceIds, tool.nativeToolName) === selectedToolKey), [selectedToolKey, tools])
  const sessionSummaries = useMemo(() => new Map((snapshot.review.response?.items ?? []).map(item => [item.id, item])), [snapshot.review.response?.items])
  const sortedTools = useMemo(() => [...tools].sort((a, b) => {
    const delta = sortMetric(a, sort.key) - sortMetric(b, sort.key)
    if (delta === 0) return a.nativeToolName.localeCompare(b.nativeToolName)
    return sort.direction === 'ascending' ? delta : -delta
  }), [tools, sort])

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
  const relaxFilters = () => model.setUsageFilters({ sourceId: '', projectId: '', range: 'all' })
  const openReviewSession = (logicalSessionId: string) => {
    const params = new URLSearchParams()
    if (usage.filters.sourceId) params.set('source', usage.filters.sourceId)
    if (usage.filters.projectId) params.set('project', usage.filters.projectId)
    params.set('range', usage.filters.range)
    params.set('status', 'all')
    navigate(`/review/${encodeURIComponent(logicalSessionId)}?${params.toString()}`)
  }

  return <main className="workspace-page">
    <Toolbar className="workspace-toolbar" aria-label="工具分析筛选">
      <AgentScope agents={agents} value={usage.filters.sourceId} onChange={sourceId => model.setUsageFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <SelectMenu className="filter" value={usage.filters.projectId} onChange={projectId => model.setUsageFilters({ projectId })} ariaLabel="筛选项目" placeholder="全部项目" menuWidth={280} searchable searchPlaceholder="搜索项目" options={[
        { value: '', label: '全部项目' },
        ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
      ]}/>
      <SelectMenu className="filter" value={usage.filters.range} onChange={range => model.setUsageFilters({ range: range as typeof usage.filters.range })} ariaLabel="筛选时间范围" menuWidth={156} options={[
        { value: 'today', label: '今天' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }, { value: 'all', label: '全部时间' },
      ]}/>
      <IconButton className="toolbar-end" onClick={() => void model.refreshUsage()} title="刷新工具分析" aria-label="刷新工具分析"><UiIcon name="refresh" size={15}/></IconButton>
    </Toolbar>

    <div className="page-content tools-content">
      <CompactPageHeading title="工具分析" description="只展示可验证的调用事实：用了什么、失败多少、耗时如何，以及有多少调用能够可靠归因到具体能力资产。"/>

      {usage.error && <ErrorStateBanner message={usage.error} onRetry={() => void model.refreshUsage()}/>} 

      {blockingError ? null : usage.loading && !data ? <WorkspaceSkeleton kind="table"/> : <>
        <section className="tool-summary-grid">
          <div className="tool-summary-card"><span>最高频</span><strong>{mostUsed?.nativeToolName ?? '—'}</strong><small>{mostUsed ? `${mostUsed.callCount} 次调用 · ${mostUsed.sessionCount} 个会话` : '暂无数据'}</small></div>
          <div className="tool-summary-card"><span>失败最多</span><strong className={mostErrors ? 'is-danger' : ''}>{mostErrors?.nativeToolName ?? '—'}</strong><small>{mostErrors ? `${mostErrors.errorCount} 次失败` : '当前范围无已知失败'}</small></div>
          <div className="tool-summary-card"><span>平均最慢</span><strong>{slowest?.nativeToolName ?? '—'}</strong><small>{slowest ? `${duration(slowest.averageDurationMs)} / 次` : '暂无数据'}</small></div>
          <div className="tool-summary-card" title="只统计有明确证据能够归因到技能或 MCP（模型上下文协议）的调用；普通命令、读取等不会被强行归因。"><span>可靠归因覆盖</span><strong>{totalCalls ? `${attributionCoverage}%` : '—'}</strong><small>{totalCalls ? `尚未可靠归因 ${unattributedCalls} 次调用` : '暂无调用数据'}</small></div>
        </section>

        <section className="tool-table-card">
          <div className="table-section-head"><div><h2>工具调用</h2><p>{tools.length} 个工具 · 点击表头排序，点击一行查看详情</p></div></div>
          <div className="table-scroll">
            {tools.length ? <table className="tool-table">
              <thead><tr>
                <th>工具</th>
                <th tabIndex={0} role="button" aria-sort={ariaSort('callCount')} onClick={() => toggleSort('callCount')} onKeyDown={event => sortKeyDown(event, 'callCount')} style={{ cursor: 'pointer' }}>调用 {sortIcon('callCount')}</th>
                <th tabIndex={0} role="button" aria-sort={ariaSort('sessionCount')} onClick={() => toggleSort('sessionCount')} onKeyDown={event => sortKeyDown(event, 'sessionCount')} style={{ cursor: 'pointer' }}>会话 {sortIcon('sessionCount')}</th>
                <th tabIndex={0} role="button" aria-sort={ariaSort('successRate')} onClick={() => toggleSort('successRate')} onKeyDown={event => sortKeyDown(event, 'successRate')} style={{ cursor: 'pointer' }}>成功率 {sortIcon('successRate')}</th>
                <th tabIndex={0} role="button" aria-sort={ariaSort('errorCount')} onClick={() => toggleSort('errorCount')} onKeyDown={event => sortKeyDown(event, 'errorCount')} style={{ cursor: 'pointer' }}>失败 {sortIcon('errorCount')}</th>
                <th tabIndex={0} role="button" aria-sort={ariaSort('averageDurationMs')} onClick={() => toggleSort('averageDurationMs')} onKeyDown={event => sortKeyDown(event, 'averageDurationMs')} style={{ cursor: 'pointer' }}>平均耗时 {sortIcon('averageDurationMs')}</th>
              </tr></thead>
              <tbody>{sortedTools.map(tool => {
                const successRate = rateValue(tool.successCount, tool.errorCount)
                const key = toolKey(tool.sourceIds, tool.nativeToolName)
                const kind = toolVisualKind(tool.nativeToolName)
                return <tr key={key} tabIndex={0} onClick={() => setSelectedToolKey(key)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedToolKey(key) } }}>
                  <td><span className="tool-table-name"><ToolKindIcon kind={kind}/><span><b className="tool-name">{tool.nativeToolName}</b><span className="tool-source">{sourceLabels(tool.sourceIds)}</span></span></span></td>
                  <td><span className="tool-bar-cell"><span>{tool.callCount}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, tool.callCount / maxCalls * 100)}%` }}/></span></span></td>
                  <td>{tool.sessionCount}</td>
                  <td><span className="tool-rate-cell" data-rate={successRate === null ? 'unknown' : successRate >= 95 ? 'good' : successRate >= 80 ? 'mid' : 'low'}><span>{rate(tool.successCount, tool.errorCount)}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${successRate ?? 0}%` }}/></span></span></td>
                  <td className={tool.errorCount ? 'cell-danger' : 'cell-muted'}>{tool.errorCount}</td><td>{duration(tool.averageDurationMs)}</td>
                </tr>
              })}</tbody>
            </table> : <div className="tools-empty-state"><EmptyStatePanel
              icon="⌕"
              title="当前筛选范围没有工具调用"
              description="试试放宽时间范围或清除项目、智能体筛选。新的工具调用进入 AgentLens 后会出现在这里。"
              action={canRelaxFilters ? { label: '放宽筛选条件', onClick: relaxFilters } : { label: '刷新', onClick: () => void model.refreshUsage() }}
              compact
            /></div>}
          </div>
        </section>

        {(mostErrors || slowest) && <section className="tool-attention">
          <div className="section-heading-row"><div><h3>需要关注</h3><p>只列当前筛选范围内有事实支撑的异常与耗时项。</p></div></div>
          <div className="tool-attention-list">
            {mostErrors && <button className="tool-attention-row" onClick={() => setSelectedToolKey(toolKey(mostErrors.sourceIds, mostErrors.nativeToolName))}>
              <span className="tool-attention-badge is-danger">失败集中</span>
              <span><b>{mostErrors.nativeToolName}</b><small>{mostErrors.errorCount} 次已知失败 · 成功率 {rate(mostErrors.successCount, mostErrors.errorCount)}</small></span>
              <strong>{mostErrors.errorCount} 次</strong>
            </button>}
            {slowest && <button className="tool-attention-row" onClick={() => setSelectedToolKey(toolKey(slowest.sourceIds, slowest.nativeToolName))}>
              <span className="tool-attention-badge is-warning">平均最慢</span>
              <span><b>{slowest.nativeToolName}</b><small>{slowest.callCount} 次调用 · {slowest.sessionCount} 个会话</small></span>
              <strong>{duration(slowest.averageDurationMs)}</strong>
            </button>}
          </div>
        </section>}

        {assets.length ? <section className="attributed-assets">
          <div className="section-heading-row"><div><h3>可归因能力资产</h3><p>有证据能够关联到具体技能和 MCP（模型上下文协议）的真实调用</p></div></div>
          <div className="attributed-asset-list">{assets.map(asset => <div key={`${asset.type}:${asset.canonicalName}`} className="attributed-asset"><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type)}</span><span title={`归因方式：${asset.attribution}`}>{confidenceLabel(asset.confidence)}</span><span className="asset-usage-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, asset.callCount / maxAssetCalls * 100)}%` }}/></span><strong>{asset.callCount}</strong><small>次</small></div>)}</div>
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
          <div className="tool-drill-stat"><b>{selectedTool.callCount}</b><span>调用次数</span></div>
          <div className="tool-drill-stat"><b>{selectedTool.sessionCount}</b><span>涉及会话</span></div>
          <div className="tool-drill-stat"><b>{rate(selectedTool.successCount, selectedTool.errorCount)}</b><span>成功率</span></div>
          <div className="tool-drill-stat"><b className={selectedTool.errorCount ? 'cell-danger' : ''}>{selectedTool.errorCount}</b><span>失败次数</span></div>
          <div className="tool-drill-stat"><b>{duration(selectedTool.totalDurationMs)}</b><span>总耗时</span></div>
          <div className="tool-drill-stat"><b>{duration(selectedTool.averageDurationMs)}</b><span>平均耗时</span></div>
        </div>
        <section className="tool-session-section">
          <div className="table-section-head"><div><h2>会话分布 · Top 3</h2><p>按该工具在会话中的调用次数排序 · 点击直接进入任务复盘</p></div></div>
          <div className="tool-session-list">
            {selectedTool.sessions.slice(0, 3).map(session => {
              const summary = sessionSummaries.get(session.logicalSessionId)
              const label = summary?.title ?? summary?.preview ?? `会话 ${shortSessionId(session.logicalSessionId)}`
              const max = selectedTool.sessions[0]?.callCount ?? 1
              return <button key={session.logicalSessionId} className="tool-session-link" onClick={() => openReviewSession(session.logicalSessionId)} title={label}>
                <span className="tool-session-copy"><b>{label}</b><small>{sourceLabels(summary?.sourceIds ?? selectedTool.sourceIds)} · {session.callCount} 次调用</small></span>
                <span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(5, session.callCount / max * 100)}%` }}/></span>
                <span className="tool-session-open">打开 <UiIcon name="arrow-right" size={13}/></span>
              </button>
            })}
            {!selectedTool.sessions.length && <div className="tool-drill-note">当前范围没有可定位的会话记录。</div>}
          </div>
          {selectedTool.sessions.length > 3 && <div className="tool-drill-note">前 3 个会话 · 共 {selectedTool.sessions.length} 个。完整调用过程、输入输出和 Evidence（证据）在任务复盘中查看。</div>}
        </section>
        {selectedTool.errorCount > 0 && <div className="tool-drill-note">当前聚合接口只提供失败次数和相关会话，不包含可安全展示的逐次错误载荷；错误示例请进入上方相关会话查看，避免用推测内容冒充事实。</div>}
      </div>
    </Drawer>}
  </main>
}
