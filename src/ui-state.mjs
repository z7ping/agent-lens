export function getExpandAllAction(expandedStates) {
  return expandedStates.every(Boolean) && expandedStates.length > 0 ? 'collapse' : 'expand';
}

export function shouldShowToolType(rowType, activeFilter) {
  return !activeFilter || activeFilter === 'all' || rowType === activeFilter;
}

export function shouldShowToolTypeSet(rowTypes, activeFilter) {
  if (!activeFilter || activeFilter === 'all') return true;
  if (!Array.isArray(rowTypes) || rowTypes.length === 0) return true;
  return rowTypes.includes(activeFilter);
}

export function getToolTypeDisplay(rows, activeFilter) {
  return rows.map(row => shouldShowToolType(row.type, activeFilter) ? '' : 'none');
}

export function filterOverviewTools(tools, source) {
  if (!source || source === 'all') return tools;
  return tools.filter(tool => tool.tool === source);
}

export function orderOverviewTools(tools, preferredOrder = []) {
  const orderIndex = new Map((preferredOrder || []).map((tool, index) => [tool, index]));
  return [...tools].sort((a, b) => {
    const aSaved = orderIndex.has(a.tool);
    const bSaved = orderIndex.has(b.tool);
    if (aSaved || bSaved) {
      if (aSaved && bSaved) return orderIndex.get(a.tool) - orderIndex.get(b.tool);
      return aSaved ? -1 : 1;
    }
    const orderDiff = Number(a.order ?? 999) - Number(b.order ?? 999);
    if (orderDiff !== 0) return orderDiff;
    return String(a.display_name || a.tool || '').localeCompare(String(b.display_name || b.tool || ''));
  });
}

export function moveToolInOrder(order, draggedTool, targetTool) {
  if (!draggedTool || !targetTool || draggedTool === targetTool) return [...(order || [])];
  const next = [...(order || [])];
  const from = next.indexOf(draggedTool);
  const to = next.indexOf(targetTool);
  if (from === -1 || to === -1) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function isLatestRequest(requestId, latestRequestId) {
  return requestId === latestRequestId;
}
