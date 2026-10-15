import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { AgentInsightsRail } from '../components/AgentInsightsRail'
import { SelectMenu } from '../components/ui'
import { AgentsPage } from './AgentsPage'
import { IntegrationManagementPage } from './IntegrationManagementPage'

type AgentWorkspaceView = 'overview' | 'ecosystem' | 'management'

export function AgentsResponsivePage({
  model,
  sourceId,
  agents,
  onSelectAgent,
  toolbarHost,
}: {
  model: AgentLensClientModel
  sourceId: string
  agents: AgentFacetDto[]
  onSelectAgent(id: string): void
  toolbarHost?: HTMLDivElement | null
}) {
  const { t } = useTranslation(['navigation', 'piEcosystem'])
  const snapshot = useClientSnapshot(model)
  const orderedAgents = useOrderedAgents(agents)
  const [searchParams, setSearchParams] = useSearchParams()
  const hasSelectedOverview = Boolean(snapshot.agents?.items.some(item => item.sourceId === sourceId))
  const hasSelectedSummary = Boolean(snapshot.agentSummaries?.items.some(item => item.sourceId === sourceId))
  const isPi = sourceId === 'pi'
  const requestedView = searchParams.get('view')
  const activeView: AgentWorkspaceView = requestedView === 'management'
    ? 'management'
    : isPi && requestedView === 'ecosystem'
      ? 'ecosystem'
      : 'overview'

  useEffect(() => {
    // Supported-but-undetected catalog entries have no overview to hydrate.
    if (!sourceId || !hasSelectedSummary) return
    void model.ensureAgentDetail(sourceId).catch(() => undefined)
  }, [model, sourceId, hasSelectedSummary])

  useEffect(() => {
    if (!hasSelectedOverview || activeView !== 'overview') return
    const timer = window.setTimeout(() => {
      void model.refreshAgentCoverage().catch(() => undefined)
    }, 1_000)
    return () => window.clearTimeout(timer)
  }, [hasSelectedOverview, model, sourceId, activeView])

  const selectAgent = (nextSourceId: string) => {
    onSelectAgent(nextSourceId)
    const next = new URLSearchParams(searchParams)
    next.set('agent', nextSourceId)
    if (next.get('view') === 'ecosystem' && nextSourceId !== 'pi') next.delete('view')
    setSearchParams(next, { replace: true })
  }

  const showInsights = hasSelectedOverview && activeView === 'overview'
  const agentOptions = orderedAgents.map(agent => ({
    value: agent.sourceId,
    label: agentLabel(agent.sourceId, agent.displayName),
  }))

  return <>
    {toolbarHost && activeView !== 'management' ? createPortal(
      <div className="workspace-view-controls">
        <div className="workspace-view-filter">
          <SelectMenu
            value={sourceId}
            options={agentOptions}
            onChange={selectAgent}
            ariaLabel={t('navigation:agentSelection')}
            placeholder={t('navigation:agentSelection')}
            searchable
          />
        </div>
      </div>,
      toolbarHost,
    ) : null}
    {activeView === 'management'
      ? <IntegrationManagementPage model={model} toolbarHost={toolbarHost ?? null}/>
      : <div className={`agents-responsive-shell ${showInsights ? '' : 'without-insights'}`}>
        <AgentsPage model={model} sourceId={sourceId} piView={activeView}/>
        {showInsights && <AgentInsightsRail snapshot={snapshot} sourceId={sourceId}/>}
      </div>}
  </>
}
