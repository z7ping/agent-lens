import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import type { AgentFacetDto } from '@agent-lens/protocol'
import {
  readAgentVisibilityPreference,
  writeAgentVisibilityPreference,
} from '../client/preferences'

export interface PinnedContextValue {
  pinned: string[]
  toggle(id: string): void
}

const PinnedContext = createContext<PinnedContextValue>({
  pinned: [],
  toggle: () => undefined,
})

export function usePinnedAgents(): PinnedContextValue {
  return useContext(PinnedContext)
}

interface VisibilityState {
  configured: boolean
  ids: string[]
}

export function PinnedAgentsProvider({
  agents,
  children,
}: PropsWithChildren<{
  agents: AgentFacetDto[]
}>) {
  const initialVisibility = useMemo(() => readAgentVisibilityPreference(), [])
  const [visibility, setVisibility] = useState<VisibilityState>(() => ({
    configured: initialVisibility !== null,
    ids: initialVisibility?.visibleAgentIds ?? [],
  }))

  useEffect(() => {
    if (!agents.length) return
    setVisibility(current => {
      const available = new Set(agents.map(agent => agent.sourceId))
      const ids = current.configured
        ? current.ids.filter(id => available.has(id))
        : agents.filter(agent => agent.detected).map(agent => agent.sourceId)
      if (
        current.configured
        && ids.join('\u0000') === current.ids.join('\u0000')
      ) return current
      writeAgentVisibilityPreference({ visibleAgentIds: ids })
      return { configured: true, ids }
    })
  }, [agents])

  const value = useMemo<PinnedContextValue>(() => ({
    pinned: visibility.ids,
    toggle(id) {
      setVisibility(current => {
        const ids = current.ids.includes(id)
          ? current.ids.filter(item => item !== id)
          : [...current.ids, id]
        writeAgentVisibilityPreference({ visibleAgentIds: ids })
        return { configured: true, ids }
      })
    },
  }), [visibility.ids])

  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>
}
