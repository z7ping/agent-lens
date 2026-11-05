import type { SessionRelationshipDto } from '@agent-lens/protocol'

/** A Pi parentSession path is not itself subagent evidence: forks and clones
 * also set it. Only use a catalog-resolved exact subagent relationship. */
export function verifiedSubagentReviewTarget(
  relation: SessionRelationshipDto,
  currentSessionId: string,
): string | undefined {
  if (relation.type !== 'subagent' || relation.confidence !== 'exact') return undefined
  if (!currentSessionId || relation.fromSessionId !== currentSessionId) return undefined
  const target = relation.toSessionId?.trim()
  return target && target !== currentSessionId ? target : undefined
}
