import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentInsightsRail } from '../components/AgentInsightsRail'
import { AgentsPage } from './AgentsPage'

export function AgentsResponsivePage({ model, sourceId, onSourceIdChange }: { model: AgentLensClientModel; sourceId: string; onSourceIdChange(sourceId: string): void }) {
  const snapshot = useClientSnapshot(model)
  return <div className="agents-responsive-shell">
    <AgentsPage model={model} sourceId={sourceId} onSourceIdChange={onSourceIdChange}/>
    <AgentInsightsRail snapshot={snapshot} sourceId={sourceId}/>
  </div>
}
