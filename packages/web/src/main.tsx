import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installLiveRecovery } from './client/live-recovery'
import { clientModel } from './client/model'
import { readTheme, writeTheme } from './client/preferences'
import './styles.css'
import './theme.css'
import './readability.css'
import './review.css'
import './review-long-session.css'
import './prototype.css'
import './states.css'
import './live-notice.css'
import './backup.css'
import './insights.css'
import './review-reference.css'
import './review-message-actions.css'
import './shell-responsive.css'
import './p0-polish.css'
import './typography.css'
import './tokens.css'
import './color-system.css'
import './v2-alignment.css'
import './review-v2-final.css'

writeTheme(readTheme())
const disposeLiveRecovery = installLiveRecovery(clientModel)
void clientModel.start()
window.addEventListener('pagehide', () => {
  disposeLiveRecovery()
  clientModel.stop()
}, { once: true })

const root = document.getElementById('root')
if (!root) throw new Error('AgentLens Web root is missing')
createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)