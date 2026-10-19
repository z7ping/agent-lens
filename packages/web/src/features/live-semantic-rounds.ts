import type { LiveTaskRoundProjection, LiveTaskRoundSegments } from './live-task-projection'

/**
 * Presentation MUST be keyed by semantic round, not legacy storage/render
 * fragments. VirtualRoundMount still virtualizes completed logical rounds.
 * A long single turn has one process disclosure and one answer action owner.
 */
export function coalesceLiveSemanticRounds(
  fragments: readonly LiveTaskRoundProjection[],
): LiveTaskRoundProjection[] {
  const result: LiveTaskRoundProjection[] = []
  let index = 0
  while (index < fragments.length) {
    const first = fragments[index]!
    const semanticId = first.model.semanticId ?? first.model.id
    let end = index + 1
    while (end < fragments.length &&
      (fragments[end]!.model.semanticId ?? fragments[end]!.model.id) === semanticId) end += 1

    if (end === index + 1 && first.model.id === semanticId) {
      result.push(first)
    } else {
      const group = fragments.slice(index, end)
      result.push({
        model: {
          ...first.model,
          id: semanticId,
          semanticId,
          state: group.some(fragment => fragment.model.state === 'running') ? 'running' : first.model.state,
        },
        items: group.flatMap(fragment => fragment.items),
      })
    }
    index = end
  }
  return result
}

export function coalesceLiveSemanticSegments(segments: LiveTaskRoundSegments): LiveTaskRoundSegments {
  return {
    stable: coalesceLiveSemanticRounds(segments.stable),
    active: coalesceLiveSemanticRounds(segments.active),
  }
}
