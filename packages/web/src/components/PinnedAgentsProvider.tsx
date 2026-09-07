import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import type { AgentFacetDto } from '@agent-lens/protocol'
import { readAgentFilterPreference, writeAgentFilterPreference } from '../client/preferences'

export interface PinnedContextValue {
  ordered: string[]
  pinned: string[]
  toggle(id: string): void
  move(id: string, targetId: string): void
  moveBy(id: string, offset: -1 | 1): void
  reset(): void
}

const PinnedContext = createContext<PinnedContextValue>({
  ordered: [],
  pinned: [],
  toggle: () => undefined,
  move: () => undefined,
  moveBy: () => undefined,
  reset: () => undefined,
})

export function usePinnedAgents(): PinnedContextValue {
  return useContext(PinnedContext)
}

export function PinnedAgentsProvider({
  agents,
  children,
}: PropsWithChildren<{ agents: AgentFacetDto[] }>) {
  const [preference, setPreference] = useState(
    () => readAgentFilterPreference() ?? { orderedAgentIds: [], visibleAgentIds: [] },
  )

  useEffect(() => {
    if (!agents.length) return
    setPreference(current => {
      const available = agents.map(agent => agent.sourceId)
      const known = current.orderedAgentIds.filter(id => available.includes(id))
      const orderedAgentIds = [...known, ...available.filter(id => !known.includes(id))]
      const visibleAgentIds = current.orderedAgentIds.length
        ? current.visibleAgentIds.filter(id => available.includes(id))
        : agents.filter(agent => agent.detected).map(agent => agent.sourceId)
      const next = { orderedAgentIds, visibleAgentIds }
      if (orderedAgentIds.join('\u0000') === current.orderedAgentIds.join('\u0000')
        && visibleAgentIds.join('\u0000') === current.visibleAgentIds.join('\u0000')) {
        return current
      }
      writeAgentFilterPreference(next)
      return next
    })
  }, [agents])

  const value = useMemo<PinnedContextValue>(() => ({
    ordered: preference.orderedAgentIds,
    pinned: preference.visibleAgentIds,
    toggle(id) {
      setPreference(current => {
        const visibleAgentIds = current.visibleAgentIds.includes(id)
          ? current.visibleAgentIds.filter(item => item !== id)
          : [...current.visibleAgentIds, id]
        const next = { ...current, visibleAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    move(id, targetId) {
      setPreference(current => {
        const from = current.orderedAgentIds.indexOf(id)
        const to = current.orderedAgentIds.indexOf(targetId)
        if (from < 0 || to < 0 || from === to) return current
        const orderedAgentIds = [...current.orderedAgentIds]
        orderedAgentIds.splice(from, 1)
        orderedAgentIds.splice(to, 0, id)
        const next = { ...current, orderedAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    moveBy(id, offset) {
      setPreference(current => {
        const from = current.orderedAgentIds.indexOf(id)
        const to = from + offset
        if (from < 0 || to < 0 || to >= current.orderedAgentIds.length) return current
        const orderedAgentIds = [...current.orderedAgentIds]
        ;[orderedAgentIds[from], orderedAgentIds[to]] = [orderedAgentIds[to]!, orderedAgentIds[from]!]
        const next = { ...current, orderedAgentIds }
        writeAgentFilterPreference(next)
        return next
      })
    },
    reset() {
      const next = {
        orderedAgentIds: agents.map(agent => agent.sourceId),
        visibleAgentIds: agents.filter(agent => agent.detected).map(agent => agent.sourceId),
      }
      writeAgentFilterPreference(next)
      setPreference(next)
    },
  }), [agents, preference])

  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>
}
