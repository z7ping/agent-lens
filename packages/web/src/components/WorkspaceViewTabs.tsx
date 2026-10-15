import { Link } from 'react-router-dom'

export interface WorkspaceViewTab {
  value: string
  label: string
  to: string
}

interface WorkspaceViewTabsProps {
  label: string
  value: string
  tabs: readonly WorkspaceViewTab[]
  nested?: boolean
  inline?: boolean
}

/** Secondary navigation is the same link-based, 40px underline tab across workspaces. */
export function WorkspaceViewTabs({ label, value, tabs, nested = false, inline = false }: WorkspaceViewTabsProps) {
  return <nav className={`workspace-view-tabs ${nested ? 'is-nested' : ''} ${inline ? 'is-inline' : ''}`.trim()} aria-label={label}>
    {tabs.map(tab => <Link
      key={tab.value}
      to={tab.to}
      className={`workspace-view-tab ${value === tab.value ? 'is-active' : ''}`}
      aria-current={value === tab.value ? 'page' : undefined}
    >{tab.label}</Link>)}
  </nav>
}
