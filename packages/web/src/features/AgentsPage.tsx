import { useState } from 'react'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'

const capabilityLabel: Record<string, string> = {
  session: 'Session',
  transcript: '对话记录',
  'tool-call': '工具调用',
  'tool-result': '工具结果',
  permission: '权限',
  subagent: 'Subagent',
  context: '上下文',
  thinking: 'Thinking',
  'asset-discovery': '资产发现',
  'asset-invocation': '资产调用',
  'artifact-action': '产物操作',
  usage: 'Usage',
}

const stateLabel: Record<string, string> = {
  installed: '已安装',
  configured: '已配置',
  enabled: '已启用',
  discoverable: '可发现',
  exposed: '已暴露',
  invoked: '已调用',
}

function StateBadge({ state, value }: { state: string; value: boolean | 'unknown' }) {
  const tone = value === true
    ? 'border-success/30 bg-success/10 text-success'
    : value === false
      ? 'border-danger/30 bg-danger/10 text-danger'
      : 'border-line bg-soft text-muted'
  return <span className={`rounded-md border px-2 py-1 text-[11px] ${tone}`}>
    {stateLabel[state] ?? state}{value === 'unknown' ? ' · 未知' : value ? '' : ' · 否'}
  </span>
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  return <button className="text-[11px] text-muted hover:text-accent" onClick={() => void copy()}>
    {copied ? '已复制' : '复制路径'}
  </button>
}

export function AgentsPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const agents = snapshot.facets?.agents ?? []
  const items = snapshot.agents?.items ?? []
  const [sourceId, setSourceId] = useState('')
  const shown = sourceId ? items.filter(item => item.sourceId === sourceId) : items

  return <main className="mx-auto max-w-[1800px]">
    <div className="toolbar">
      <AgentScope agents={agents} value={sourceId} onChange={setSourceId} />
      <button className="icon-button ml-auto" onClick={() => void model.refreshFacetsAndAgents()} title="刷新 Agent 概览">↻</button>
    </div>

    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Agent 概览</h1>
        <p className="mt-1 text-sm text-muted">看清本机 Agent 的检测状态、安装信息、能力资产与实际使用情况。</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {shown.map(agent => <article key={agent.sourceId} className="rounded-xl border border-line bg-surface p-5">
          <div className="flex items-start gap-3">
            <span className={`mt-1 size-2.5 rounded-full ${sourceDot(agent.sourceId)}`} />
            <div>
              <h2 className="font-semibold">{agentLabel(agent.sourceId, agent.displayName)}</h2>
              <div className="mt-1 text-xs text-muted">{agent.detected ? '已检测' : '未检测'} · Source 已启用</div>
            </div>
            <span className={`ml-auto rounded-full px-2 py-1 text-xs ${agent.detected ? 'bg-success/10 text-success' : 'bg-soft text-muted'}`}>
              {agent.detected ? 'Detected' : 'Not found'}
            </span>
          </div>

          <section className="mt-5">
            <h3 className="section-label">安装</h3>
            {agent.installations.length
              ? agent.installations.map(item => <div key={item.id} className="mb-2 rounded-lg bg-soft p-3 text-xs">
                  <div className="font-medium">{item.version ?? '版本未知'}</div>
                  {item.executable && <div className="mt-1 break-all text-muted">Executable · {item.executable}</div>}
                  {item.configRoot && <div className="mt-1 flex items-start gap-2 break-all text-muted"><span className="min-w-0 flex-1">Config · {item.configRoot}</span><CopyPath path={item.configRoot} /></div>}
                  {item.dataRoot && <div className="mt-1 flex items-start gap-2 break-all text-muted"><span className="min-w-0 flex-1">Data · {item.dataRoot}</span><CopyPath path={item.dataRoot} /></div>}
                </div>)
              : <div className="text-sm text-muted">尚未发现本机安装</div>}
          </section>

          <section className="mt-5">
            <h3 className="section-label">可观测能力</h3>
            <div className="flex flex-wrap gap-2">
              {agent.capabilities.map(cap => <span
                key={cap.name}
                title={cap.reason}
                className={`rounded-md border px-2 py-1 text-xs ${cap.status === 'available'
                  ? 'border-success/30 bg-success/10 text-success'
                  : cap.status === 'partial' || cap.status === 'experimental'
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : 'border-line text-muted'}`}
              >
                {capabilityLabel[cap.name] ?? cap.name} · {cap.status}
              </span>)}
            </div>
          </section>

          <section className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="section-label">能力资产</h3>
              <span className="text-[11px] text-muted">{agent.assetInventoryStatus === 'available' ? `${agent.assetInventory.length} 项` : '不可用'}</span>
            </div>
            {agent.assetInventoryStatus === 'unavailable'
              ? <div className="text-sm text-muted">当前 Storage 未提供资产库存查询能力</div>
              : agent.assetInventory.length
                ? <div className="space-y-2">
                    {agent.assetInventory.map(asset => <div key={asset.id} className="rounded-lg border border-line px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{asset.displayName ?? asset.canonicalName}</span>
                        <span className="rounded bg-soft px-1.5 py-0.5 text-[10px] uppercase text-muted">{asset.type}</span>
                      </div>
                      {asset.bindings.map(binding => <div key={binding.id} className="mt-2 border-t border-line/70 pt-2">
                        <div className="flex flex-wrap gap-1.5">
                          {binding.states.map(state => <StateBadge key={state.state} state={state.state} value={state.value} />)}
                          {!binding.states.length && <span className="text-xs text-muted">尚无状态观测</span>}
                        </div>
                        {binding.path && <div className="mt-2 flex items-start gap-2 text-xs text-muted"><span className="min-w-0 flex-1 break-all">{binding.path}</span><CopyPath path={binding.path} /></div>}
                        {(binding.source || binding.version) && <div className="mt-1 text-xs text-muted">{binding.source ?? 'source unknown'}{binding.version ? ` · ${binding.version}` : ''}</div>}
                      </div>)}
                    </div>)}
                  </div>
                : <div className="text-sm text-muted">当前没有已记录的能力资产</div>}
          </section>

          <section className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="section-label">实际使用</h3>
              <span className="text-[11px] text-muted">Evidence-based</span>
            </div>
            {agent.usedAssets.length
              ? <div className="space-y-2">
                  {agent.usedAssets.map(asset => <div key={`${asset.type}:${asset.canonicalName}`} className="flex items-center rounded-lg border border-line px-3 py-2 text-sm">
                    <span className="font-medium">{asset.canonicalName}</span>
                    <span className="ml-2 text-xs text-muted">{asset.type.toUpperCase()}</span>
                    <span className="ml-auto text-xs text-muted">{asset.callCount} 次</span>
                  </div>)}
                </div>
              : <div className="text-sm text-muted">暂无可可靠归因的 Skill / MCP 使用记录</div>}
          </section>
        </article>)}
      </div>

      {!shown.length && <div className="empty py-24">没有可显示的 Agent</div>}
    </div>
  </main>
}
