import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope } from '../components/AgentScope'

function duration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

function rate(success: number, error: number): string {
  const total = success + error
  return total ? `${Math.round(success / total * 100)}%` : '—'
}

function assetTypeLabel(type: string): string {
  if (type === 'skill') return '技能'
  if (type === 'mcp') return 'MCP（模型上下文协议）'
  return type
}

export function ToolsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const usage = snapshot.usage
  const data = usage.response
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const mostUsed = data?.tools[0]
  const errorCandidate = [...(data?.tools ?? [])].sort((a, b) => b.errorCount - a.errorCount)[0]
  const mostErrors = errorCandidate?.errorCount ? errorCandidate : undefined
  const slowest = [...(data?.tools ?? [])].sort((a, b) => b.averageDurationMs - a.averageDurationMs)[0]

  return <main className="workspace-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={usage.filters.sourceId} onChange={sourceId => model.setUsageFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <select className="filter" value={usage.filters.projectId} onChange={e => model.setUsageFilters({ projectId: e.target.value })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name ?? p.repositoryIdentity ?? p.id}</option>)}</select>
      <select className="filter" value={usage.filters.range} onChange={e => model.setUsageFilters({ range: e.target.value as typeof usage.filters.range })}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <button className="icon-button toolbar-end" onClick={() => void model.refreshUsage()} title="刷新工具分析" aria-label="刷新工具分析">↻</button>
    </div>

    <div className="page-content tools-content">
      <header className="page-heading"><div><span className="eyebrow">使用情况</span><h1>工具分析</h1><p>只展示可验证的调用事实：用了什么、失败多少、耗时如何。</p></div></header>

      <section className="tool-summary-grid">
        <div className="tool-summary-card"><span>最高频</span><strong>{mostUsed?.nativeToolName ?? '—'}</strong><small>{mostUsed ? `${mostUsed.callCount} 次调用 · ${mostUsed.sessionCount} 个会话` : '暂无数据'}</small></div>
        <div className="tool-summary-card"><span>失败最多</span><strong className={mostErrors ? 'is-danger' : ''}>{mostErrors?.nativeToolName ?? '—'}</strong><small>{mostErrors ? `${mostErrors.errorCount} 次失败` : '当前范围无已知失败'}</small></div>
        <div className="tool-summary-card"><span>平均最慢</span><strong>{slowest?.nativeToolName ?? '—'}</strong><small>{slowest ? `${duration(slowest.averageDurationMs)} / 次` : '暂无数据'}</small></div>
      </section>

      <section className="tool-table-card">
        <div className="table-section-head"><div><h2>工具调用</h2><p>{data?.tools.length ?? 0} 个工具</p></div></div>
        <div className="table-scroll">
          <table className="tool-table">
            <thead><tr><th>工具</th><th>调用</th><th>会话</th><th>成功率</th><th>失败</th><th>总耗时</th><th>平均耗时</th></tr></thead>
            <tbody>{data?.tools.map(tool => <tr key={`${tool.sourceIds.join('-')}:${tool.nativeToolName}`}>
              <td><b className="tool-name">{tool.nativeToolName}</b><span className="tool-source">{tool.sourceIds.join(' / ')}</span></td>
              <td>{tool.callCount}</td><td>{tool.sessionCount}</td><td>{rate(tool.successCount, tool.errorCount)}</td><td className={tool.errorCount ? 'cell-danger' : 'cell-muted'}>{tool.errorCount}</td><td>{duration(tool.totalDurationMs)}</td><td>{duration(tool.averageDurationMs)}</td>
            </tr>)}</tbody>
          </table>
          {!data?.tools.length && <div className="empty-state roomy">当前筛选范围没有工具调用</div>}
        </div>
      </section>

      {data?.assets.length ? <section className="attributed-assets">
        <div className="section-heading-row"><div><h3>可归因能力资产</h3><p>有证据能够关联到具体技能和 MCP（模型上下文协议）的真实调用</p></div></div>
        <div className="attributed-asset-list">{data.assets.map(asset => <div key={`${asset.type}:${asset.canonicalName}`} className="attributed-asset"><b>{asset.canonicalName}</b><span>{assetTypeLabel(asset.type)}</span><strong>{asset.callCount}</strong><small>次</small></div>)}</div>
      </section> : null}
    </div>
  </main>
}
