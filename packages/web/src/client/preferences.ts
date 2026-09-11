const PINNED_KEY = 'agent-lens.pinned-agents.v1'
const AGENT_FILTER_KEY = 'agent-lens.agent-filter.v2'
const AGENT_VISIBILITY_KEY = 'agent-lens.agent-visibility.v1'
const THEME_KEY = 'agent-lens.theme.v1'
const SIDEBAR_COLLAPSED_KEY = 'agent-lens.sidebar-collapsed.v1'

export interface AgentFilterPreference {
  orderedAgentIds: string[]
  visibleAgentIds: string[]
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []
}

export function readAgentFilterPreference(): AgentFilterPreference | null {
  try {
    const raw = localStorage.getItem(AGENT_FILTER_KEY)
    if (raw !== null) {
      const value = JSON.parse(raw) as Partial<AgentFilterPreference>
      return { orderedAgentIds: uniqueStrings(value.orderedAgentIds), visibleAgentIds: uniqueStrings(value.visibleAgentIds) }
    }
    const legacy = readPinnedAgents()
    return legacy === null ? null : { orderedAgentIds: legacy, visibleAgentIds: legacy }
  } catch { return null }
}

export function writeAgentFilterPreference(preference: AgentFilterPreference): void {
  localStorage.setItem(AGENT_FILTER_KEY, JSON.stringify({
    orderedAgentIds: uniqueStrings(preference.orderedAgentIds),
    visibleAgentIds: uniqueStrings(preference.visibleAgentIds),
  }))
}

export interface AgentVisibilityPreference {
  visibleAgentIds: string[]
}

export function readAgentVisibilityPreference(): AgentVisibilityPreference | null {
  try {
    const raw = localStorage.getItem(AGENT_VISIBILITY_KEY)
    if (raw !== null) {
      const value = JSON.parse(raw) as Partial<AgentVisibilityPreference>
      return { visibleAgentIds: uniqueStrings(value.visibleAgentIds) }
    }
    const legacy = readAgentFilterPreference()
    return legacy ? { visibleAgentIds: [...legacy.visibleAgentIds] } : null
  } catch { return null }
}

export function writeAgentVisibilityPreference(preference: AgentVisibilityPreference): void {
  localStorage.setItem(AGENT_VISIBILITY_KEY, JSON.stringify({
    visibleAgentIds: uniqueStrings(preference.visibleAgentIds),
  }))
}

/**
 * Read-only migration source for Slice B. New code must never persist global
 * display order back to browser storage.
 */
export function readLegacyAgentOrderPreference(): string[] {
  return readAgentFilterPreference()?.orderedAgentIds ?? []
}

function readPinnedAgents(): string[] | null {
  try {
    const raw = localStorage.getItem(PINNED_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
  } catch { return null }
}

export type ThemePreference = 'light' | 'dark'
export function readTheme(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
export function writeTheme(theme: ThemePreference): void {
  localStorage.setItem(THEME_KEY, theme)
  document.documentElement.dataset.theme = theme
}

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true' } catch { return false }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)) } catch { /* ignore unavailable storage */ }
}
