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

export function isLatestRequest(requestId, latestRequestId) {
  return requestId === latestRequestId;
}
