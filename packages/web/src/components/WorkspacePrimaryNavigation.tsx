import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  labelKey: 'task' | 'insights' | 'agents'
  ariaLabelKey?: 'taskCenter'
  icon: 'task' | 'trend' | 'agent'
  update: 'insights' | 'agents' | null
}> = [
  { id: 'review', to: '/review', labelKey: 'task', ariaLabelKey: 'taskCenter', icon: 'task', update: null },
  { id: 'insights', to: '/insights', labelKey: 'insights', icon: 'trend', update: 'insights' },
  { id: 'agents', to: '/agents', labelKey: 'agents', icon: 'agent', update: 'agents' },
]

/** 工作区一级导航的唯一渲染入口，页面只提供当前状态与数据提示。 */
export function WorkspacePrimaryNavigation({
  activeSection,
  hasInsightsUpdate,
  hasAgentsUpdate,
  onNavigate,
}: WorkspacePrimaryNavigationProps) {
  const { t } = useTranslation('navigation')
  return <nav className="workspace-primary-nav" aria-label={t('primary')}>
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
        <span aria-label={section.ariaLabelKey ? t(section.ariaLabelKey) : undefined}>{t(section.labelKey)}</span>
        {hasUpdate && <i className="workspace-nav-dot" aria-label={t('common:newData')}/>}
      </NavLink>
    })}
  </nav>
}
