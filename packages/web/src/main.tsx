import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installLiveRecovery } from './client/live-recovery'
import { clientModel } from './client/model'
import { installPiLiveKeyboard } from './client/pi-live-keyboard'
import { readTheme, writeTheme } from './client/preferences'
import { initializeI18n } from './i18n/runtime'
import './styles.css'
import './tokens.css'
import './theme.css'
import './typography.css'
import './readability.css'
import './semantic-colors.css'
import './shell.css'
import './components/workspace-sidebar.css'
import './components/workspace-sidebar-interactions.css'
import './shell-responsive.css'
import './release-info.css'
import './states.css'
import './live-notice.css'
import './backup.css'
import './backup-scroll.css'
import './backup-overlays.css'
import './backup-responsive.css'
import './insights.css'
import './tools.css'
import './agents.css'
import './integration-onboarding.css'
import './agent-insights-responsive.css'
import './review.css'
import './review-long-session.css'
import './pi-live.css'
import './components/markdown-content.css'
import './components/copyable-code-block.css'
import './components/pi-markdown-composer.css'
import './components/pi-startup-disclosure.css'
import './task-center.css'
import './hub-review.css'
import './task-view-options.css'
import './task-turn-rail.css'
import './components/task-continuation.css'
// Task Surface 详情组件只持有 Header / Round / Message / Tool / Event 等组件自身样式。
import './task-detail.css'
// Session View 最后持有 Review / Pi Live 的 Header 几何、Reader、阅读轴与可选 Composer 外层。
import './task-session-view.css'
import './components/ui/ui-primitives.css'
import './components/ui/overlay.css'
import './components/select-menu.css'

writeTheme(readTheme())
const disposeLiveRecovery = installLiveRecovery(clientModel)
const disposePiLiveKeyboard = installPiLiveKeyboard()
void clientModel.start()
window.addEventListener('pagehide', () => {
  disposePiLiveKeyboard()
  disposeLiveRecovery()
  clientModel.stop()
}, { once: true })

async function bootstrap() {
  await initializeI18n()
  const root = document.getElementById('root')
  if (!root) throw new Error('AgentLens Web root is missing')
  createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)
}

void bootstrap()
