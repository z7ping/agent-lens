/** All AgentLens multi-agent filters share the same contract: null means "all",
 * selecting one agent narrows to that agent, and later clicks toggle explicit IDs.
 * An empty array stays empty until the user explicitly chooses "all". */
export function nextAgentFilterSelection(
  selection: readonly string[] | null,
  sourceId: string,
  detectedIds: readonly string[],
): string[] | null {
  if (!detectedIds.includes(sourceId)) return selection === null ? null : [...selection]
  if (selection === null) return [sourceId]
  return selection.includes(sourceId)
    ? selection.filter(id => id !== sourceId)
    : [...selection, sourceId]
}
