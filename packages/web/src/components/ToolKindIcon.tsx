export type ToolVisualKind = 'shell' | 'read' | 'edit' | 'search' | 'test' | 'mcp' | 'web' | 'tool'

export function toolVisualKind(name: string): ToolVisualKind {
  const value = name.toLowerCase()
  if (value.includes('mcp')) return 'mcp'
  if (/(web|browser|http|url)/.test(value)) return 'web'
  if (/(test|spec|vitest|jest|playwright|pytest|unittest|测试)/.test(value)) return 'test'
  if (/(bash|shell|exec|command|terminal|powershell|cmd)/.test(value)) return 'shell'
  if (/(read|cat|open[_-]?file|get[_-]?file|view[_-]?file)/.test(value)) return 'read'
  if (/(write|edit|patch|replace|create[_-]?file|apply[_-]?patch)/.test(value)) return 'edit'
  if (/(grep|search|find|glob|ripgrep|rg)/.test(value)) return 'search'
  return 'tool'
}

export function toolVisualLabel(kind: ToolVisualKind): string {
  if (kind === 'shell') return 'Shell'
  if (kind === 'read') return '读取'
  if (kind === 'edit') return '修改'
  if (kind === 'search') return '搜索'
  if (kind === 'test') return '测试'
  if (kind === 'mcp') return 'MCP'
  if (kind === 'web') return '网络'
  return '工具'
}

export function ToolKindIcon({ kind, className = '' }: { kind: ToolVisualKind; className?: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return <span className={`tool-kind-svg tool-kind-${kind} ${className}`.trim()} aria-hidden="true">
    <svg viewBox="0 0 16 16" focusable="false">
      {kind === 'shell' && <><path {...common} d="M3 4.5 6 8l-3 3.5"/><path {...common} d="M7.5 11.5H13"/></>}
      {kind === 'read' && <><path {...common} d="M4 2.5h6l2 2v9H4z"/><path {...common} d="M10 2.5v2h2"/><path {...common} d="M6 7h4M6 9.5h4"/></>}
      {kind === 'edit' && <><path {...common} d="M3 12.5 3.8 9l6.7-6.5 3 3L6.8 12z"/><path {...common} d="m9.3 3.7 3 3"/></>}
      {kind === 'search' && <><circle {...common} cx="7" cy="7" r="3.5"/><path {...common} d="m9.8 9.8 3.2 3.2"/></>}
      {kind === 'test' && <><path {...common} d="M5 2.5v4l-2.5 5A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-2l-2.5-5v-4"/><path {...common} d="M4.5 9h7"/></>}
      {kind === 'mcp' && <><circle {...common} cx="4" cy="8" r="1.5"/><circle {...common} cx="12" cy="4" r="1.5"/><circle {...common} cx="12" cy="12" r="1.5"/><path {...common} d="M5.5 7.4 10.5 4.6M5.5 8.6l5 2.8"/></>}
      {kind === 'web' && <><circle {...common} cx="8" cy="8" r="5"/><path {...common} d="M3 8h10M8 3c1.5 1.5 2.2 3.2 2.2 5S9.5 11.5 8 13M8 3C6.5 4.5 5.8 6.2 5.8 8S6.5 11.5 8 13"/></>}
      {kind === 'tool' && <><path {...common} d="M6.5 3.2a3 3 0 0 0 3.7 3.7l2.6 2.6-3.3 3.3-2.6-2.6a3 3 0 0 0-3.7-3.7L5 8.3 8.3 5z"/></>}
    </svg>
  </span>
}
