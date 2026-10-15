export function orderAgentsByPreference<T extends { sourceId: string }>(
  agents: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(agents.map(agent => [agent.sourceId, agent]))
  const preferredIds = new Set(orderedIds)

  return [
    ...[...preferredIds].map(id => byId.get(id)).filter((agent): agent is T => Boolean(agent)),
    ...agents.filter(agent => !preferredIds.has(agent.sourceId)),
  ]
}

/** URL choices always win; otherwise keep an explicit in-app choice or use the first visible option. */
export function resolveAgentOverviewSource(
  orderedSourceIds: readonly string[],
  requestedSourceId: string,
  lastSelectedSourceId: string,
): string {
  const available = new Set(orderedSourceIds)
  if (requestedSourceId && available.has(requestedSourceId)) return requestedSourceId
  if (lastSelectedSourceId && available.has(lastSelectedSourceId)) return lastSelectedSourceId
  return orderedSourceIds[0] ?? ''
}
