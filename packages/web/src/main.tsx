import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installInspectorOutsideDismiss } from './client/inspector-dismiss'
import { installLiveRecovery } from './client/live-recovery'
import { clientModel } from './client/model'
import { installPiLiveKeyboard } from './client/pi-live-keyboard'
import { readTheme, writeTheme } from './client/preferences'
import { installTaskSurfaceDefaults } from './client/task-surface-defaults'
import './styles.css'
import './tokens.css'
import './theme.css'
import './typography.css'
import './readability.css'
import './semantic-colors.css'
import './shell.css'
import './shell-responsive.css'
import './release-info.css'
import './states.css'
import './live-notice.css'
import './backup.css'
import './backup-overlays.css'
import './insights.css'
import './tools.css'
import './agents.css'
import './review.css'
import './review-long-session.css'
import './pi-live.css'
import './task-center.css'
import './task-execution.css'
import './hub-review.css'
import './desktop-responsive.css'
import './task-detail-prototype.css'
import './agent-insights-responsive.css'
import './backup-responsive.css'
import './task-detail-polish.css'
import './task-feedback-polish.css'

writeTheme(readTheme())
const disposeLiveRecovery = installLiveRecovery(clientModel)
const disposeInspectorOutsideDismiss = installInspectorOutsideDismiss()
const disposePiLiveKeyboard = installPiLiveKeyboard()
const disposeTaskSurfaceDefaults = installTaskSurfaceDefaults()
void clientModel.start()
window.addEventListener('pagehide', () => {
  disposeTaskSurfaceDefaults()
  disposePiLiveKeyboard()
  disposeInspectorOutsideDismiss()
  disposeLiveRecovery()
  clientModel.stop()
}, { once: true })

const root = document.getElementById('root')
if (!root) throw new Error('AgentLens Web root is missing')
createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)
