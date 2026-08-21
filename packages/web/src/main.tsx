import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { clientModel } from './client/model'
import { readTheme, writeTheme } from './client/preferences'
import './styles.css'

writeTheme(readTheme())
void clientModel.start()

const root = document.getElementById('root')
if (!root) throw new Error('AgentLens Web root is missing')
createRoot(root).render(<StrictMode><App model={clientModel} /></StrictMode>)
