const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const outputDir = path.resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'codex-semantics-bootstrap.txt'), `started ${new Date().toISOString()}\n`, 'utf8')

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.on('window-all-closed', () => {})

import('../codex-semantics-real.mjs').catch(error => {
  const text = error instanceof Error ? error.stack || error.message : String(error)
  fs.writeFileSync(path.join(outputDir, 'codex-semantics-bootstrap-error.txt'), `${text}\n`, 'utf8')
  console.error(text)
  app.exit(1)
})
