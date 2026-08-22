import { useMemo, useState } from 'react'
import type { ToolUsageDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope } from '../components/AgentScope'
import { EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from '../components/StateViews'

function duration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

function rateValue(success: number, error: number): number {
  const total = success + error
  return total ? Math.round(success / total * 100) : 0
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

type SortKey = 'callCount' | 'sessionCount' | 'successRate' | 'errorCount' | 'totalDurationMs' | 'averageDurationMs'
type SortDirection = 'ascending' | 'descending'

function sortMetric(tool: ToolUsageDto, key: SortKey): number {
  if (key === 'successRate') return rateValue(tool.successCount, tool.errorCount)
  return tool[key]
}

export function ToolsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const usage = snapshot.usage
  const data = usage.response
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const tools = data?.tools ?? []
  const assets = data?.assets ?? []
  const mostUsed = [...tools].sort((a, b) => b.callCount - a.callCount)[0]
  const errorCandidate = [...tools].sort((a, b) => b.errorCount - a.errorCount)[0]
  const mostErrors = errorCandidate?.errorCount ? errorCandidate : undefined
  const slowest = [...tools].sort((a, b) => b.averageDurationMs - a.averageDurationMs)[0]
  const totalCalls = tools.reduce((sum, tool) => sum + tool.callCount, 0)
  const unattributedCalls = data?.meta.unattributedToolCalls ?? 0
  const attributedCalls = Math.max(0, totalCalls - unattributedCalls)
  const attributionCoverage = totalCalls ? Math.round(attributedCalls / totalCalls * 100) : 0
  const maxCalls = Math.max(1, ...tools.map(tool => tool.callCount))
  const canRelaxFilters = Boolean(usage.filters.sourceId || usage.filters.projectId || usage.filters.range !== 'all')
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'callCount', direction: 'descending' })
  const selectedTool = useMemo(() => tools.find(tool => toolKey(tool.sourceIds, tool.nativeToolName) === selectedToolKey), [selectedToolKey, tools])
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
  const relaxFilters = () => model.setUsageFilters({ sourceId: '', projectId: '', range: 'all' })

  return <main className="workspace-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={usage.filters.sourceId} onChange={sourceId => model.setUsageFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <select className="filter" value={usage.filters.projectId} onChange={e => model.setUsageFilters({ projectId: e.target.value })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name ?? p.repositoryIdentity ?? p.id}</option>)}</select>
      <select className="filter" value={usage.filters.range} onChange={e => model.setUsageFilters({ range: e.target.value as typeof usage.filters.range })}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <button className="icon-button toolbar-end" onClick={() => void model.refreshUsage()} title="刷新工具分析" aria-label="刷新工具分析">↻</button>
    </div>

    <div className="page-content tools-content">
      <header className="page-heading"><div><span className="eyebrow">使用情况</span><h1>工具分析</h1><p>只展示可验证的调用事实：用了什么、失败多少、耗时如何，以及有多少调用能够可靠归因到具体能力资产。</p></div></header>

      {usage.error && <ErrorStateBanner message={usage.error} onRetry={() => void model.refreshUsage()}/>} 

      {usage.loading && !data ? <WorkspaceSkeleton kind="table"/> : <>
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
                <th aria-sort={ariaSort('callCount')} onClick={() => toggleSort('callCount')} style={{ cursor: 'pointer' }}>调用 {sort.key === 'callCount' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
                <th aria-sort={ariaSort('sessionCount')} onClick={() => toggleSort('sessionCount')} style={{ cursor: 'pointer' }}>会话 {sort.key === 'sessionCount' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
                <th aria-sort={ariaSort('successRate')} onClick={() => toggleSort('successRate')} style={{ cursor: 'pointer' }}>成功率 {sort.key === 'successRate' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
                <th aria-sort={ariaSort('errorCount')} onClick={() => toggleSort('errorCount')} style={{ cursor: 'pointer' }}>失败 {sort.key === 'errorCount' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
                <th aria-sort={ariaSort('totalDurationMs')} onClick={() => toggleSort('totalDurationMs')} style={{ cursor: 'pointer' }}>总耗时 {sort.key === 'totalDurationMs' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
                <th aria-sort={ariaSort('averageDurationMs')} onClick={() => toggleSort('averageDurationMs')} style={{ cursor: 'pointer' }}>平均耗时 {sort.key === 'averageDurationMs' ? sort.direction === 'descending' ? '↓' : '↑' : ''}</th>
              </tr></thead>
              <tbody>{sortedTools.map(tool => {
                const successRate = rateValue(tool.successCount, tool.errorCount)
                const key = toolKey(tool.sourceIds, tool.nativeToolName)
                return <tr key={key} tabIndex={0} onClick={() => setSelectedToolKey(key)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedToolKey(key) } }}>
                  <td><b className="tool-name">{tool.nativeToolName}</b><span className="tool-source">{tool.sourceIds.join(' / ')}</span></td>
                  <td><span className="tool-bar-cell"><span>{tool.callCount}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, tool.callCount / maxCalls * 100)}%` }}/></span></span></td>
                  <td>{tool.sessionCount}</td>
                  <td><span className="tool-rate-cell" data-rate={successRate >= 95 ? 'good' : successRate >= 80 ? 'mid' : 'low'}><span>{rate(tool.successCount, tool.errorCount)}</span><span className="metric-bar" aria-hidden="true"><i style={{ width: `${successRate}%` }}/></span></span></td>
                  <td className={tool.errorCount ? 'cell-danger' : 'cell-muted'}>{tool.errorCount}</td><td>{duration(tool.totalDurationMs)}</td><td>{duration(tool.averageDurationMs)}</td>
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

        {assets.length ? <section className="attributed-assets">
          <div className="section-heading-row"><div><h3>可归因能力资产</h3><p>有证据能够关联到具体技能和 MCP（模型上下文协议）的真实调用</p></div></div>
          <div className="attributed-asset-list">{assets.map(asset => <div key={`${asset.type}:${asset.canonicalName}`} className="attributed-asset"><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type)}</span><span title={`归因方式：${asset.attribution}`}>{confidenceLabel(asset.confidence)}</span><strong>{asset.callCount}</strong><small>次</small></div>)}</div>
        </section> : null}
      </>}
    </div>

    {selectedTool && <>
      <button className="tool-drawer-scrim" onClick={() => setSelectedToolKey(null)} aria-label="关闭工具详情" />
      <aside className="tool-drill-drawer" aria-label="工具详情">
        <header className="tool-drill-head">
          <div><span className="eyebrow">工具详情</span><h2>{selectedTool.nativeToolName}</h2><span className="tool-source">{selectedTool.sourceIds.join(' / ')}</span></div>
          <button className="icon-button" onClick={() => setSelectedToolKey(null)} aria-label="关闭工具详情">×</button>
        </header>
        <div className="tool-drill-body">
          <div className="tool-drill-grid">
            <div className="tool-drill-stat"><b>{selectedTool.callCount}</b><span>调用次数</span></div>
            <div className="tool-drill-stat"><b>{selectedTool.sessionCount}</b><span>涉及会话</span></div>
            <div className="tool-drill-stat"><b>{rate(selectedTool.successCount, selectedTool.errorCount)}</b><span>成功率</span></div>
            <div className="tool-drill-stat"><b className={selectedTool.errorCount ? 'cell-danger' : ''}>{selectedTool.errorCount}</b><span>失败次数</span></div>
            <div className="tool-drill-stat"><b>{duration(selectedTool.totalDurationMs)}</b><span>总耗时</span></div>
            <div className="tool-drill-stat"><b>{duration(selectedTool.averageDurationMs)}</b><span>平均耗时</span></div>
          </div>
          <div className="tool-drill-note">当前工具分析接口提供聚合事实，不虚构逐次错误或会话分布。具体调用过程、输入输出和证据可在“任务复盘”中定位对应会话查看。</div>
        </div>
      </aside>
    </>}
  </main>
}