import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type { AgentFacetDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { agentLabel, useOrderedAgents } from '../components/AgentScope'
import { AgentInsightsRail } from '../components/AgentInsightsRail'
import { SelectMenu, ToolbarGroup } from '../components/ui'
import { AgentsPage } from './AgentsPage'
import { IntegrationManagementPage } from './IntegrationManagementPage'

type AgentWorkspaceView = 'overview' | 'ecosystem' | 'management'

export function AgentsResponsivePage({
  model,
  sourceId,
  agents,
  onSelectAgent,
  topbarHost,
}: {
  model: AgentLensClientModel
  sourceId: string
  agents: AgentFacetDto[]
  onSelectAgent(id: string): void
  topbarHost?: HTMLDivElement | null
}) {
  const { t } = useTranslation(['navigation', 'piEcosystem'])
  const snapshot = useClientSnapshot(model)
  const orderedAgents = useOrderedAgents(agents)
  const [searchParams, setSearchParams] = useSearchParams()
  const hasSelectedOverview = Boolean(snapshot.agents?.items.some(item => item.sourceId === sourceId))
  const isPi = sourceId === 'pi'
  const requestedView = searchParams.get('view')
  const activeView: AgentWorkspaceView = requestedView === 'management'
    ? 'management'
    : isPi && requestedView === 'ecosystem'
      ? 'ecosystem'
      : 'overview'

  useEffect(() => {
    // Supported-but-undetected catalog entries have no overview to hydrate.
    if (!sourceId || !snapshot.agentSummaries?.items.some(item => item.sourceId === sourceId)) return
    void model.ensureAgentDetail(sourceId).catch(() => undefined)
  }, [model, sourceId, snapshot.agentSummaries])

  useEffect(() => {
    if (!hasSelectedOverview || activeView !== 'overview') return
    const timer = window.setTimeout(() => {
      void model.refreshAgentCoverage().catch(() => undefined)
    }, 1_000)
    return () => window.clearTimeout(timer)
  }, [hasSelectedOverview, model, sourceId, activeView])

  const setActiveView = (view: AgentWorkspaceView) => {
    const next = new URLSearchParams(searchParams)
    if (view === 'overview') {
      next.delete('view')
      if (sourceId) next.set('agent', sourceId)
    } else {
      next.set('view', view)
      if (view === 'management' && sourceId) {
        const selected = agents.find(item => item.sourceId === sourceId)
        const management = snapshot.integrationManagement?.items.find(item =>
          item.integrationId === sourceId || (selected && item.productId === selected.productId),
        )
        next.set('agent', management?.integrationId ?? sourceId)
      }
    }
    setSearchParams(next, { replace: true })
  }

  const selectAgent = (nextSourceId: string) => {
    onSelectAgent(nextSourceId)
    const next = new URLSearchParams(searchParams)
    const selected = agents.find(item => item.sourceId === nextSourceId)
    const management = snapshot.integrationManagement?.items.find(item =>
      item.integrationId === nextSourceId || (selected && item.productId === selected.productId),
    )
    next.set('agent', activeView === 'management' ? management?.integrationId ?? nextSourceId : nextSourceId)
    if (next.get('view') === 'ecosystem' && nextSourceId !== 'pi') next.delete('view')
    setSearchParams(next, { replace: true })
  }

  const showInsights = hasSelectedOverview && activeView === 'overview'
  const agentOptions = orderedAgents.map(agent => ({
    value: agent.sourceId,
    label: agentLabel(agent.sourceId, agent.displayName),
  }))

  return <>
    {topbarHost ? createPortal(
      <div className="agent-workspace-topbar-tools">
        <ToolbarGroup className="agent-view-switcher" role="group" aria-label={t('navigation:agentViews')}>
          <button
            type="button"
            aria-pressed={activeView === 'overview'}
            className={`scope-chip ${activeView === 'overview' ? 'scope-chip-active' : ''}`}
            onClick={() => setActiveView('overview')}
          >{t('navigation:overview')}</button>
          <button
            type="button"
            aria-pressed={activeView === 'management'}
            className={`scope-chip ${activeView === 'management' ? 'scope-chip-active' : ''}`}
            onClick={() => setActiveView('management')}
          >{t('navigation:agentIntegration')}</button>
          {isPi && <button
            type="button"
            aria-pressed={activeView === 'ecosystem'}
            className={`scope-chip ${activeView === 'ecosystem' ? 'scope-chip-active' : ''}`}
            onClick={() => setActiveView('ecosystem')}
          >{t('piEcosystem:ecosystemTab')}</button>}
        </ToolbarGroup>
        <div className="agent-workspace-agent-picker">
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
      topbarHost,
    ) : null}
    {activeView === 'management'
      ? <IntegrationManagementPage model={model} topbarHost={topbarHost}/>
      : <div className={`agents-responsive-shell ${showInsights ? '' : 'without-insights'}`}>
        <AgentsPage model={model} sourceId={sourceId} piView={activeView}/>
        {showInsights && <AgentInsightsRail snapshot={snapshot} sourceId={sourceId}/>}
      </div>}
  </>
}
