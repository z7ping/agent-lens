import type { ClientSnapshot } from '../client/model'
import { CommandRow, EmptyStatePanel, WorkspaceSkeleton } from './StateViews'

export function AgentsStateOverlay({ snapshot }: { snapshot: ClientSnapshot }) {
  const response = snapshot.agents
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected)
  const shellClass = `agents-state-overlay ${hasSseBanner ? 'has-sse-banner' : ''}`

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
