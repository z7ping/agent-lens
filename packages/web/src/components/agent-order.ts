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
