import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope } from '../components/AgentScope'

function duration(ms:number):string{if(ms<1000)return `${ms}ms`;if(ms<60_000)return `${(ms/1000).toFixed(1)}s`;return `${(ms/60_000).toFixed(1)}m`}
function rate(success:number,error:number):string{const total=success+error;return total?`${Math.round(success/total*100)}%`:'—'}

export function ToolsPage({model}:{model:AgentLensClientModel}){
 const snapshot=useClientSnapshot(model),usage=snapshot.usage,data=usage.response,agents=snapshot.facets?.agents??[],projects=snapshot.facets?.projects??[]
 const mostUsed=data?.tools[0],mostErrors=[...(data?.tools??[])].sort((a,b)=>b.errorCount-a.errorCount)[0],slowest=[...(data?.tools??[])].sort((a,b)=>b.averageDurationMs-a.averageDurationMs)[0]
 return <main className="mx-auto max-w-[1800px]">
  <div className="toolbar"><AgentScope agents={agents} value={usage.filters.sourceId} onChange={sourceId=>model.setUsageFilters({sourceId})}/><div className="toolbar-divider"/><select className="filter" value={usage.filters.projectId} onChange={e=>model.setUsageFilters({projectId:e.target.value})}><option value="">全部项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name??p.repositoryIdentity??p.id}</option>)}</select><select className="filter" value={usage.filters.range} onChange={e=>model.setUsageFilters({range:e.target.value as typeof usage.filters.range})}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select><button className="icon-button ml-auto" onClick={()=>void model.refreshUsage()}>↻</button></div>
  <div className="p-6"><div className="mb-6"><h1 className="text-xl font-semibold">工具分析</h1><p className="mt-1 text-sm text-muted">先展示客观调用事实；价值评分与工作流建议留给 Analyzer。</p></div>
   <div className="mb-6 grid gap-3 md:grid-cols-3"><div className="stat-card"><span>最高频</span><b>{mostUsed?.nativeToolName??'—'}</b><small>{mostUsed?`${mostUsed.callCount} 次调用`:'暂无数据'}</small></div><div className="stat-card"><span>失败最多</span><b>{mostErrors?.nativeToolName??'—'}</b><small>{mostErrors?`${mostErrors.errorCount} 次失败`:'暂无数据'}</small></div><div className="stat-card"><span>平均最慢</span><b>{slowest?.nativeToolName??'—'}</b><small>{slowest?duration(slowest.averageDurationMs):'暂无数据'}</small></div></div>
   <div className="overflow-hidden rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><thead className="bg-soft text-xs text-muted"><tr><th>工具</th><th>调用</th><th>Sessions</th><th>成功率</th><th>失败</th><th>总耗时</th><th>平均耗时</th></tr></thead><tbody>{data?.tools.map(tool=><tr key={`${tool.sourceIds.join('-')}:${tool.nativeToolName}`} className="border-t border-line"><td className="font-mono font-medium">{tool.nativeToolName}<div className="mt-1 text-xs font-sans text-muted">{tool.sourceIds.join(' / ')}</div></td><td>{tool.callCount}</td><td>{tool.sessionCount}</td><td>{rate(tool.successCount,tool.errorCount)}</td><td className={tool.errorCount?'text-danger':''}>{tool.errorCount}</td><td>{duration(tool.totalDurationMs)}</td><td>{duration(tool.averageDurationMs)}</td></tr>)}</tbody></table>{!data?.tools.length&&<div className="empty py-16">当前筛选范围没有工具调用</div>}</div>
   {data?.assets.length?<div className="mt-7"><h2 className="mb-3 text-sm font-semibold">可归因能力资产</h2><div className="flex flex-wrap gap-2">{data.assets.map(asset=><span key={`${asset.type}:${asset.canonicalName}`} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"><b>{asset.canonicalName}</b><span className="ml-2 text-xs text-muted">{asset.type.toUpperCase()} · {asset.callCount}</span></span>)}</div></div>:null}
  </div>
 </main>
}
