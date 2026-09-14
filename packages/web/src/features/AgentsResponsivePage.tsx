import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentInsightsRail } from '../components/AgentInsightsRail'
import { AgentsPage } from './AgentsPage'

export function AgentsResponsivePage({ model, sourceId }: { model: AgentLensClientModel; sourceId: string }) {
  const snapshot = useClientSnapshot(model)
  const hasSelectedOverview = Boolean(snapshot.agents?.items.some(item => item.sourceId === sourceId))
  return <div className={`agents-responsive-shell ${hasSelectedOverview ? '' : 'without-insights'}`}>
    <AgentsPage model={model} sourceId={sourceId}/>
    {hasSelectedOverview && <AgentInsightsRail snapshot={snapshot} sourceId={sourceId}/>}
  </div>
}
