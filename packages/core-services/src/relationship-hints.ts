import type {
  AgentInstallationId,
  ObservationCandidate,
  SessionRelationshipCandidate,
} from '@agent-lens/core'

/**
 * Derive only the relationship fact that is directly supported by identity hints.
 * A native parent is not automatically a fork/resume/subagent. Sources that know
 * a stronger native relation should emit an explicit SessionRelationshipCandidate.
 */
export function deriveParentRelationshipCandidates(
  sourceId: string,
  installationId: AgentInstallationId,
  observations: readonly ObservationCandidate[],
): SessionRelationshipCandidate[] {
  const unique = new Map<string, SessionRelationshipCandidate>()
  for (const observation of observations) {
    const child = observation.identityHints.nativeSessionId
    const parent = observation.identityHints.nativeParentSessionId
    if (!child || !parent || child === parent) continue
    const key = `${parent}\u0000${child}`
    if (unique.has(key)) continue
    unique.set(key, {
      sourceId,
      installationId,
      fromNativeSessionId: parent,
      toNativeSessionId: child,
      type: 'related',
      nativeRelation: 'parent',
      confidence: 'high',
    })
  }
  return [...unique.values()]
}
