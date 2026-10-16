import { useCallback, useSyncExternalStore } from 'react'
import type { AgentLensClientModel, ClientSnapshot } from './model'

/** 完整快照只留给 Shell 等确实消费多个领域的组件。 */
export function useClientSnapshot(model: AgentLensClientModel): ClientSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

/** 未变更的领域保持同一快照引用，防止无关状态变更触发额外渲染。 */
export function useClientSnapshotField<K extends keyof ClientSnapshot>(
  model: AgentLensClientModel,
  field: K,
): ClientSnapshot[K] {
  const read = useCallback(() => model.getSnapshot()[field], [model, field])
  return useSyncExternalStore(model.subscribe, read, read)
}
