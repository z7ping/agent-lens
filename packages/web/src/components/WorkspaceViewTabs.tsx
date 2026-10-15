import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconButton, UiIcon } from './ui'

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
  onOpenNavigation?: () => void
}

/** Secondary navigation is the same link-based, 40px underline tab across workspaces. */
export function WorkspaceViewTabs({ label, value, tabs, nested = false, inline = false, onOpenNavigation }: WorkspaceViewTabsProps) {
  const { t } = useTranslation('navigation')
  return <nav className={`workspace-view-tabs ${nested ? 'is-nested' : ''} ${inline ? 'is-inline' : ''}`.trim()} aria-label={label}>
    {onOpenNavigation && !inline && <IconButton className="workspace-mobile-nav-button" onClick={onOpenNavigation} title={t('openWorkspaceNavigation')} aria-label={t('openWorkspaceNavigation')}><UiIcon name="menu" size={16}/></IconButton>}
    {tabs.map(tab => <Link
      key={tab.value}
      to={tab.to}
      className={`workspace-view-tab ${value === tab.value ? 'is-active' : ''}`}
      aria-current={value === tab.value ? 'page' : undefined}
    >{tab.label}</Link>)}
  </nav>
}
