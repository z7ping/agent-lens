import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { AgentFacetDto, IntegrationManagementResponseDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import {
  readAgentVisibilityPreference,
  readLegacyAgentOrderPreference,
  writeAgentVisibilityPreference,
} from '../client/preferences'

export interface PinnedContextValue {
  ordered: string[]
  pinned: string[]
  canReorder(id: string): boolean
  toggle(id: string): void
  move(id: string, targetId: string): void
  moveBy(id: string, offset: -1 | 1): void
  reset(): void
}

const PinnedContext = createContext<PinnedContextValue>({
  ordered: [],
  pinned: [],
  canReorder: () => false,
  toggle: () => undefined,
  move: () => undefined,
  moveBy: () => undefined,
  reset: () => undefined,
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
  management,
  model,
  children,
}: PropsWithChildren<{
  agents: AgentFacetDto[]
  management: IntegrationManagementResponseDto | null
  model: AgentLensClientModel
}>) {
  const legacyOrder = useRef(readLegacyAgentOrderPreference())
  const migrationAttempted = useRef(false)
  const initialVisibility = useMemo(() => readAgentVisibilityPreference(), [])
  const [visibility, setVisibility] = useState<VisibilityState>(() => ({
    configured: initialVisibility !== null,
    ids: initialVisibility?.visibleAgentIds ?? [],
  }))
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)

  const managedIds = useMemo(
    () => new Set(management?.items.map(item => item.integrationId) ?? []),
    [management],
  )
  const serverOrder = management?.preferences.displayOrder ?? []
  const pendingLegacyMigration = Boolean(
    management
    && !management.preferences.displayOrderConfigured
    && legacyOrder.current.length,
  )
  const ordered = optimisticOrder
    ?? (pendingLegacyMigration
      ? legacyOrder.current
      : serverOrder.length
        ? serverOrder
        : legacyOrder.current)

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

  useEffect(() => {
    if (!management || management.preferences.displayOrderConfigured || migrationAttempted.current) return
    const migrationOrder = legacyOrder.current
    if (!migrationOrder.length) return
    migrationAttempted.current = true
    void model.updateIntegrationPreferences({ displayOrder: migrationOrder }).catch(() => {
      migrationAttempted.current = false
    })
  }, [management, model])

  const persistOrder = (next: string[]) => {
    setOptimisticOrder(next)
    void model.updateIntegrationPreferences({ displayOrder: next }).then(
      () => setOptimisticOrder(null),
      () => setOptimisticOrder(null),
    )
  }

  const value = useMemo<PinnedContextValue>(() => ({
    ordered,
    pinned: visibility.ids,
    canReorder: id => managedIds.has(id),
    toggle(id) {
      setVisibility(current => {
        const ids = current.ids.includes(id)
          ? current.ids.filter(item => item !== id)
          : [...current.ids, id]
        writeAgentVisibilityPreference({ visibleAgentIds: ids })
        return { configured: true, ids }
      })
    },
    move(id, targetId) {
      if (!managedIds.has(id) || !managedIds.has(targetId)) return
      const from = ordered.indexOf(id)
      const to = ordered.indexOf(targetId)
      if (from < 0 || to < 0 || from === to) return
      const next = [...ordered]
      next.splice(from, 1)
      next.splice(to, 0, id)
      persistOrder(next)
    },
    moveBy(id, offset) {
      if (!managedIds.has(id)) return
      const managedOrder = ordered.filter(item => managedIds.has(item))
      const from = managedOrder.indexOf(id)
      const to = from + offset
      if (from < 0 || to < 0 || to >= managedOrder.length) return
      ;[managedOrder[from], managedOrder[to]] = [managedOrder[to]!, managedOrder[from]!]
      persistOrder(managedOrder)
    },
    reset() {
      setOptimisticOrder(null)
      void model.updateIntegrationPreferences({ displayOrder: [] }).catch(() => undefined)
    },
  }), [managedIds, model, ordered, visibility.ids])

  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>
}
