import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentInsightsRail } from '../components/AgentInsightsRail'
import { ToolbarGroup } from '../components/ui'
import { AgentsPage } from './AgentsPage'

type PiAgentView = 'overview' | 'ecosystem'

export function AgentsResponsivePage({
  model,
  sourceId,
  topbarHost,
}: {
  model: AgentLensClientModel
  sourceId: string
  topbarHost?: HTMLDivElement | null
}) {
  const { t } = useTranslation('piEcosystem')
  const snapshot = useClientSnapshot(model)
  const [searchParams, setSearchParams] = useSearchParams()
  const hasSelectedOverview = Boolean(snapshot.agents?.items.some(item => item.sourceId === sourceId))

  useEffect(() => {
    if (!sourceId) return
    void model.ensureAgentDetail(sourceId).catch(() => undefined)
  }, [model, sourceId])

  useEffect(() => {
    if (!hasSelectedOverview) return
    const timer = window.setTimeout(() => {
      void model.refreshAgentCoverage().catch(() => undefined)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [hasSelectedOverview, model, sourceId])
  const isPi = sourceId === 'pi'
  const activeView: PiAgentView = isPi && searchParams.get('view') === 'ecosystem'
    ? 'ecosystem'
    : 'overview'

  const setActiveView = (view: PiAgentView) => {
    const next = new URLSearchParams(searchParams)
    if (view === 'ecosystem') next.set('view', 'ecosystem')
    else next.delete('view')
    setSearchParams(next, { replace: true })
  }

  const showInsights = hasSelectedOverview && activeView === 'overview'

  return <>
    {isPi && topbarHost ? createPortal(
      <ToolbarGroup className="agent-view-switcher" role="group" aria-label={t('tabsAria')}>
        <button
          type="button"
          aria-pressed={activeView === 'overview'}
          className={`scope-chip ${activeView === 'overview' ? 'scope-chip-active' : ''}`}
          onClick={() => setActiveView('overview')}
        >{t('overviewTab')}</button>
        <button
          type="button"
          aria-pressed={activeView === 'ecosystem'}
          className={`scope-chip ${activeView === 'ecosystem' ? 'scope-chip-active' : ''}`}
          onClick={() => setActiveView('ecosystem')}
        >{t('ecosystemTab')}</button>
      </ToolbarGroup>,
      topbarHost,
    ) : null}
    <div className={`agents-responsive-shell ${showInsights ? '' : 'without-insights'}`}>
      <AgentsPage model={model} sourceId={sourceId} piView={activeView}/>
      {showInsights && <AgentInsightsRail snapshot={snapshot} sourceId={sourceId}/>}
    </div>
  </>
}
