import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { IntegrationManagementResponseDto } from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { readLegacyAgentOrderPreference } from '../client/preferences'

export interface IntegrationOrderContextValue {
  ordered: string[]
  canReorder(id: string): boolean
  move(id: string, targetId: string): void
  moveBy(id: string, offset: -1 | 1): void
  reset(): void
}

const IntegrationOrderContext = createContext<IntegrationOrderContextValue>({
  ordered: [],
  canReorder: () => false,
  move: () => undefined,
  moveBy: () => undefined,
  reset: () => undefined,
})

export function useIntegrationOrder(): IntegrationOrderContextValue {
  return useContext(IntegrationOrderContext)
}

export function IntegrationOrderProvider({
  management,
  model,
  children,
}: PropsWithChildren<{
  management: IntegrationManagementResponseDto | null
  model: AgentLensClientModel
}>) {
  const legacyOrder = useRef(readLegacyAgentOrderPreference())
  const migrationAttempted = useRef(false)
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

  const value = useMemo<IntegrationOrderContextValue>(() => ({
    ordered,
    canReorder: id => managedIds.has(id),
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
  }), [managedIds, model, ordered])

  return <IntegrationOrderContext.Provider value={value}>
    {children}
  </IntegrationOrderContext.Provider>
}
