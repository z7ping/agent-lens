import { NavLink } from 'react-router-dom'
import { UiIcon } from './ui'

export type WorkspacePrimarySection = 'review' | 'insights' | 'agents'

interface WorkspacePrimaryNavigationProps {
  activeSection?: WorkspacePrimarySection | undefined
  hasInsightsUpdate: boolean
  hasAgentsUpdate: boolean
  onNavigate(): void
}

const PRIMARY_SECTIONS: Array<{
  id: WorkspacePrimarySection
  to: string
  label: string
  ariaLabel?: string
  icon: 'task' | 'trend' | 'agent'
  update: 'insights' | 'agents' | null
}> = [
  { id: 'review', to: '/review', label: '任务', ariaLabel: '任务中心', icon: 'task', update: null },
  { id: 'insights', to: '/insights', label: '洞察', icon: 'trend', update: 'insights' },
  { id: 'agents', to: '/agents', label: '智能体', icon: 'agent', update: 'agents' },
]

/** 工作区一级导航的唯一渲染入口，页面只提供当前状态与数据提示。 */
export function WorkspacePrimaryNavigation({
  activeSection,
  hasInsightsUpdate,
  hasAgentsUpdate,
  onNavigate,
}: WorkspacePrimaryNavigationProps) {
  return <nav className="workspace-primary-nav" aria-label="主导航">
    {PRIMARY_SECTIONS.map(section => {
      const hasUpdate = section.update === 'insights'
        ? hasInsightsUpdate
        : section.update === 'agents' && hasAgentsUpdate
      return <NavLink
        key={section.id}
        to={section.to}
        onClick={onNavigate}
        className={`workspace-primary-link ${activeSection === section.id ? 'is-active' : ''}`}
      >
        <UiIcon name={section.icon} size={16}/>
        <span aria-label={section.ariaLabel}>{section.label}</span>
        {hasUpdate && <i className="workspace-nav-dot" aria-label="有新数据"/>}
      </NavLink>
    })}
  </nav>
}
