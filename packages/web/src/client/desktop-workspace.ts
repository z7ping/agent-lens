interface AgentLensDesktopBridge {
  selectWorkspace(): Promise<string | null>
}

declare global {
  interface Window {
    agentLensDesktop?: AgentLensDesktopBridge
  }
}

export function canSelectDesktopWorkspace(): boolean {
  return typeof window !== 'undefined' && typeof window.agentLensDesktop?.selectWorkspace === 'function'
}

export async function selectDesktopWorkspace(): Promise<string | null> {
  if (!canSelectDesktopWorkspace()) return null
  const selected = await window.agentLensDesktop!.selectWorkspace()
  return typeof selected === 'string' && selected.trim() ? selected.trim() : null
}
