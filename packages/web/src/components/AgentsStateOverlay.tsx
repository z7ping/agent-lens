import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { useTranslation } from 'react-i18next'
import { CommandRow, EmptyStatePanel, ErrorStateBanner, WorkspaceSkeleton } from './StateViews'

export function AgentsStateOverlay({ model, snapshot }: { model: AgentLensClientModel; snapshot: ClientSnapshot }) {
  const { t } = useTranslation('agents')
  const response = snapshot.agents
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected)
  const shellClass = `agents-state-overlay ${hasSseBanner ? 'has-sse-banner' : ''}`

  if (!response && snapshot.agentsError) {
    return <div className={`${shellClass} is-empty`}>
      <div className="agents-state-inner">
        <ErrorStateBanner message={snapshot.agentsError} onRetry={() => void model.refreshFacetsAndAgents()}/>
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
          title={t('overlay.noAgentsTitle')}
          description={t('overlay.noAgentsDescription')}
        >
          <CommandRow command="agent-lens doctor"/>
        </EmptyStatePanel>
      </div>
    </div>
  }

  return null
}
