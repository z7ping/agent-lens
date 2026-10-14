/** Task Center uses null for the explicit "all sources" mode, not a mutable
 * list of checked agents. The first click narrows to one agent; later clicks
 * toggle that explicit set without changing the meaning of "all". */
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
