import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { clientModel } from './client/model'
import { readTheme, writeTheme } from './client/preferences'
import './styles.css'
import './theme.css'
import './readability.css'
import './review.css'
import './review-long-session.css'
import './prototype.css'
import './review-polish.css'
import './states.css'
import './live-notice.css'

writeTheme(readTheme())
void clientModel.start()
window.addEventListener('pagehide', () => clientModel.stop(), { once: true })

const root = document.getElementById('root')
if (!root) throw new Error('AgentLens Web root is missing')
createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)