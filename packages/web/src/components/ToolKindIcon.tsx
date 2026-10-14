import { UiIcon, type UiIconName } from './UiIcon'
import { agentLensI18n } from '../i18n/runtime'

export type ToolVisualKind = 'shell' | 'read' | 'edit' | 'search' | 'test' | 'mcp' | 'web' | 'tool'

/** Tool identity belongs to the native registration, not a substring in the name. */
export interface ToolOriginEvidence {
  sourceType?: 'builtin' | 'mcp' | 'plugin' | 'extension' | 'skill-runtime' | 'unknown' | undefined
  mcpServerId?: string | undefined
}
export function toolVisualKind(name: string, evidence?: ToolOriginEvidence): ToolVisualKind {
  if (evidence?.sourceType === 'mcp' || evidence?.mcpServerId?.trim()) return 'mcp'
  const value = name.trim().toLowerCase()
  if (/^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/.test(value) || /^mcp:[^:]+:[^:]+$/.test(value)) return 'mcp'
  if (/(?:^|[_:./-])(web|browser|http|url)(?:$|[_:./-])/.test(value)) return 'web'
  if (/(?:^|[_:./-])(test|spec|vitest|jest|playwright|pytest|unittest|测试)(?:$|[_:./-])/.test(value)) return 'test'
  // "execute" is not "exec": dbx_execute_query must not be presented as Shell.
  if (/(?:^|[_:./-])(bash|shell|exec|exec_command|command|terminal|powershell|cmd)(?:$|[_:./-])/.test(value)) return 'shell'
  if (/(?:^|[_:./-])(read|cat|open_file|get_file|view_file)(?:$|[_:./-])/.test(value)) return 'read'
  if (/(?:^|[_:./-])(write|edit|patch|replace|create_file|apply_patch)(?:$|[_:./-])/.test(value)) return 'edit'
  if (/(?:^|[_:./-])(grep|search|find|glob|ripgrep|rg)(?:$|[_:./-])/.test(value)) return 'search'
  return 'tool'
}

export function toolVisualLabel(kind: ToolVisualKind): string {
  return agentLensI18n.t(`task:tool.kind.${kind}`)
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
