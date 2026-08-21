import { Fragment, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type { ReviewEventNodeDto, ReviewNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'

function formatTime(value: string): string { return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) }
function duration(ms: number): string { if(ms<1000)return `${ms}ms`; if(ms<60_000)return `${(ms/1000).toFixed(1)}s`; return `${Math.round(ms/60_000)}m` }
function payloadRecord(value: unknown): Record<string, unknown> { return value && typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{} }
function sourceEventLabel(node: ReviewEventNodeDto): string {
  const payload=payloadRecord(node.payload); const action=typeof payload.action==='string'?payload.action:typeof payload.event==='string'?payload.event:''
  if(node.sourceId==='codex') {
    if(node.kind==='context.compaction')return 'Codex · 上下文压缩'
    if(node.kind==='subagent.spawn')return 'Codex · 启动 Subagent'
    if(node.kind==='subagent.end')return 'Codex · Subagent 完成'
    if(node.kind==='permission.request')return 'Codex · 权限请求'
    if(node.kind==='session.lifecycle'&&action.toLowerCase().includes('stop'))return 'Codex · Turn Stop'
  }
  if(node.sourceId==='claude-code') {
    if(node.kind==='permission.request')return 'Claude · 权限请求'
    if(node.kind==='subagent.spawn')return 'Claude · 启动 Subagent'
    if(node.kind==='context.summary')return 'Claude · Summary'
    if(node.kind==='context.compaction')return 'Claude · Compact'
  }
  if(node.sourceId==='pi') {
    if(node.kind==='model.changed')return 'Pi · 模型切换'
    if(node.kind==='context.compaction')return 'Pi · Compaction'
    if(node.kind==='context.summary')return 'Pi · Branch Summary'
  }
  return node.label
}

function Inspector({ node, onClose }: { node: ReviewNodeDto; onClose(): void }) {
  return <div className="fixed inset-y-0 right-0 z-50 w-[min(520px,92vw)] overflow-y-auto border-l border-line bg-surface p-5 shadow-2xl">
    <div className="mb-5 flex items-center justify-between"><div><div className="text-xs text-muted">事件检查器</div><div className="font-semibold">{node.type === 'tool' ? node.name : node.type === 'event' ? sourceEventLabel(node) : node.role}</div></div><button className="icon-button" onClick={onClose}>×</button></div>
    <section className="space-y-2"><h3 className="section-label">Evidence</h3>{node.evidence.length ? node.evidence.map(item => <div key={item.id} className="rounded-lg border border-line bg-soft p-3 text-xs"><div className="flex gap-2"><b>{item.captureMethod}</b><span>{item.derivation}</span><span>{item.confidence}</span></div><div className="mt-1 break-all text-muted">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div></div>) : <div className="text-sm text-muted">无 Evidence</div>}</section>
    <section className="mt-6"><h3 className="section-label">Raw Payload</h3><pre className="raw-json">{JSON.stringify(node.payload,null,2)}</pre></section>
  </div>
}

function ToolRow({ node, inspect }: { node: ReviewToolNodeDto; inspect(node: ReviewNodeDto): void }) {
  const status=node.status==='error'?'text-danger':node.status==='success'?'text-success':'text-muted'
  return <button className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-soft" onClick={()=>inspect(node)}>
    <span className={`mt-1 text-xs ${status}`}>{node.status==='error'?'●':node.status==='success'?'✓':'○'}</span>
    <span className="min-w-0 flex-1"><span className="font-mono text-xs font-medium">{node.name}</span>{node.input!==undefined&&<span className="ml-2 truncate text-xs text-muted">{JSON.stringify(node.input).slice(0,100)}</span>}</span>
    {node.durationMs!==undefined&&<span className="text-xs text-muted">{duration(node.durationMs)}</span>}
  </button>
}

function Interaction({ nodes, inspect }: { nodes: ReviewNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const groups=useMemo(()=>{const result:Array<ReviewNodeDto|{type:'tool-group';items:ReviewToolNodeDto[]}>=[]; let tools:ReviewToolNodeDto[]=[]; const flush=()=>{if(tools.length){result.push({type:'tool-group',items:tools});tools=[]}}; for(const node of nodes){if(node.type==='tool'){tools.push(node);continue} flush();result.push(node)} flush(); return result},[nodes])
  return <div className="space-y-4">{groups.map((entry,index)=>{
    if(entry.type==='tool-group')return <details key={`tools-${index}`} className="tool-group"><summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">执行过程 · {entry.items.length} 次工具调用 <span className="text-xs font-normal text-muted">· {entry.items.filter(item=>item.status==='error').length} 错误</span></summary><div className="border-t border-line py-1">{entry.items.map(node=><ToolRow key={node.id} node={node} inspect={inspect}/>)}</div></details>
    if(entry.type==='message')return <div key={entry.id} className={`message ${entry.role==='user'?'message-user':entry.role==='assistant'?'message-assistant':'message-reasoning'}`}><div className="mb-1 text-xs font-medium text-muted">{entry.role==='user'?'用户':entry.role==='assistant'?'Agent':'Thinking'} · {formatTime(entry.at)}</div><div className="markdown"><ReactMarkdown>{entry.text}</ReactMarkdown></div>{entry.evidence.length>0&&<button className="mt-2 text-xs text-muted hover:text-accent" onClick={()=>inspect(entry)}>证据 · {entry.evidence.length}</button>}</div>
    const event=entry as ReviewEventNodeDto
    return <button key={event.id} className={`event-row event-${event.category}`} onClick={()=>inspect(event)}><span className={`size-1.5 rounded-full ${sourceDot(event.sourceId)}`}/><span>{sourceEventLabel(event)}</span><span className="ml-auto text-xs text-muted">{formatTime(event.at)}</span></button>
  })}</div>
}

export function ReviewPage({ model }: { model: AgentLensClientModel }) {
  const snapshot=useClientSnapshot(model); const {sessionId}=useParams(); const navigate=useNavigate(); const [inspect,setInspect]=useState<ReviewNodeDto|null>(null)
  const review=snapshot.review; const agents=snapshot.facets?.agents??[]; const projects=snapshot.facets?.projects??[]
  useEffect(()=>{if(sessionId&&sessionId!==review.selectedId)void model.selectReviewSession(sessionId)},[sessionId])
  const select=(id:string)=>{void model.selectReviewSession(id);navigate(`/review/${encodeURIComponent(id)}`)}
  return <main className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px] flex-col">
    <div className="toolbar">
      <AgentScope agents={agents} value={review.filters.sourceId} onChange={sourceId=>model.setReviewFilters({sourceId})}/>
      <div className="toolbar-divider"/>
      <select className="filter" value={review.filters.projectId} onChange={e=>model.setReviewFilters({projectId:e.target.value})}><option value="">全部项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name??p.repositoryIdentity??p.id}</option>)}</select>
      <select className="filter" value={review.filters.range} onChange={e=>model.setReviewFilters({range:e.target.value as typeof review.filters.range})}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <select className="filter" value={review.filters.status} onChange={e=>model.setReviewFilters({status:e.target.value as typeof review.filters.status})}><option value="all">全部状态</option><option value="clean">无错误</option><option value="with-errors">有错误</option></select>
      <input className="filter ml-auto w-56" placeholder="搜索任务…" value={review.filters.search} onChange={e=>model.setReviewFilters({search:e.target.value})}/>
      <button className="icon-button" onClick={()=>void model.refreshReview()} title="刷新">↻</button>
    </div>
    <div className="min-h-0 flex-1 md:grid md:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="session-list border-r border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><span className="text-sm font-semibold">Sessions</span><span className="text-xs text-muted">{review.response?.items.length??0}</span></div>
        <div className="overflow-y-auto">{review.loading&&!review.response&&<div className="empty">加载 Session…</div>}{review.response?.items.map(item=><button key={item.id} className={`session-item ${review.selectedId===item.id?'session-item-active':''}`} onClick={()=>select(item.id)}><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${sourceDot(item.sourceIds[0]??'')}`}/><span className="text-xs font-medium">{agentLabel(item.sourceIds[0]??'',item.productId)}</span><span className="ml-auto text-xs text-muted">{formatTime(item.endedAt)}</span></div><div className="mt-2 line-clamp-2 text-sm font-medium">{item.title??item.preview??item.projectName??'未命名 Session'}</div><div className="mt-2 flex gap-3 text-xs text-muted"><span>{item.projectName??item.workspacePath?.split(/[\\/]/).pop()??'无项目'}</span><span>{item.toolCount} tools</span>{item.errorCount>0&&<span className="text-danger">{item.errorCount} errors</span>}</div></button>)}</div>
      </aside>
      <section className="min-w-0 overflow-y-auto bg-canvas">
        {review.error&&<div className="m-5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{review.error}</div>}
        {!review.detail?<div className="empty h-full">选择一个 Session 开始复盘</div>:<div className="mx-auto max-w-4xl px-6 py-6">
          <div className="mb-6 border-b border-line pb-5"><div className="flex items-center gap-2 text-sm text-muted"><span className={`size-2 rounded-full ${sourceDot(review.detail.sourceIds[0]??'')}`}/><span>{review.detail.sourceIds.map(id=>agentLabel(id)).join(' / ')}</span><span>·</span><span>{review.detail.projectName??review.detail.workspacePath??'无项目'}</span></div><h1 className="mt-2 text-xl font-semibold">{review.detail.title??review.detail.preview??'Session 复盘'}</h1><div className="mt-3 flex flex-wrap gap-4 text-xs text-muted"><span>{formatTime(review.detail.startedAt)} → {formatTime(review.detail.endedAt)}</span><span>{duration(review.detail.durationMs)}</span><span>{review.detail.interactionCount} interactions</span><span>{review.detail.toolCount} tools</span>{review.detail.errorCount>0&&<span className="text-danger">{review.detail.errorCount} errors</span>}</div>
          {review.detail.sourceIds.includes('pi')&&review.relationships?.items.length?<div className="mt-4 rounded-lg border border-line bg-soft px-3 py-2 text-xs"><span className="font-medium">Pi Session Tree</span>{review.relationships.items.map(item=><div key={item.id} className="mt-1 font-mono text-muted">{item.fromNativeSessionId??item.fromSessionId} → {item.toNativeSessionId??item.toSessionId}</div>)}</div>:null}</div>
          <div className="space-y-8">{review.detail.interactions.map(interaction=><section key={interaction.id}><div className="mb-3 flex items-center gap-3"><span className="text-xs font-semibold text-muted">Interaction #{interaction.ordinal}</span><span className="h-px flex-1 bg-line"/></div><Interaction nodes={interaction.nodes} inspect={setInspect}/></section>)}</div>
        </div>}
      </section>
    </div>
    {inspect&&<Inspector node={inspect} onClose={()=>setInspect(null)}/>} 
  </main>
}
