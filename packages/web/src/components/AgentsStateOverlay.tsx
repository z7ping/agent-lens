import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { CommandRow, EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from './StateViews'

export function AgentsStateOverlay({ model, snapshot }: { model: AgentLensClientModel; snapshot: ClientSnapshot }) {
  const response = snapshot.agents
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected)
  const shellClass = `agents-state-overlay ${hasSseBanner ? 'has-sse-banner' : ''}`

  if (!response && snapshot.facets) {
    return <div className={`${shellClass} is-empty`}>
      <div className="agents-state-inner">
        <ErrorStateBanner message="智能体概览暂时无法加载。后台服务仍可访问，可重试概览查询或运行诊断命令。" onRetry={() => void model.refreshFacetsAndAgents()}/>
      </div>
    </div>
  }

  if (!response) {
    return <div className={`${shellClass} is-loading`} aria-live="polite">
      <div className="agents-state-inner"><WorkspaceSkeleton kind="cards"/></div>
    </div>
  }

  if (!response.items.some(agent => agent.detected)) {
    return <div className={`${shellClass} is-empty`}>
      <div className="agents-state-inner">
        <EmptyStatePanel
          icon="◇"
          title="未检测到受支持的智能体"
          description="本机暂未检测到 Codex、Claude Code 或 Pi。AgentLens 不会把“未观察到”直接判断成“未安装”，可先运行诊断命令确认检测路径。"
        >
          <CommandRow command="agent-lens doctor"/>
        </EmptyStatePanel>
      </div>
    </div>
  }

  return null
}
