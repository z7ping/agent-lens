import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installInspectorOutsideDismiss } from './client/inspector-dismiss'
import { installLiveRecovery } from './client/live-recovery'
import { clientModel } from './client/model'
import { installPiLiveKeyboard } from './client/pi-live-keyboard'
import { readTheme, writeTheme } from './client/preferences'
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
import './backup-responsive.css'
import './insights.css'
import './tools.css'
import './agents.css'
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
// Task Surface 共享详情组件最后加载；页面所有者不得再定义这些共享选择器。
import './task-detail.css'

writeTheme(readTheme())
const disposeLiveRecovery = installLiveRecovery(clientModel)
const disposeInspectorOutsideDismiss = installInspectorOutsideDismiss()
const disposePiLiveKeyboard = installPiLiveKeyboard()
void clientModel.start()
window.addEventListener('pagehide', () => {
  disposePiLiveKeyboard()
  disposeInspectorOutsideDismiss()
  disposeLiveRecovery()
  clientModel.stop()
}, { once: true })

const root = document.getElementById('root')
if (!root) throw new Error('AgentLens Web root is missing')
createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)
