import { UiIcon, type UiIconName } from './UiIcon'

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

const iconByKind: Record<ToolVisualKind, UiIconName> = {
  shell: 'tool-shell',
  read: 'tool-read',
  edit: 'tool-edit',
  search: 'tool-search',
  test: 'tool-test',
  mcp: 'tool-mcp',
  web: 'tool-web',
  tool: 'tool-generic',
}

export function ToolKindIcon({ kind, className = '' }: { kind: ToolVisualKind; className?: string }) {
  return <span className={`tool-kind-svg tool-kind-${kind} ${className}`.trim()} aria-hidden="true">
    <UiIcon name={iconByKind[kind]} size={16}/>
  </span>
}
