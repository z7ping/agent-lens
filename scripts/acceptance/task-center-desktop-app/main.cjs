const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const outputDir = path.resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'electron-bootstrap.txt'), `started ${new Date().toISOString()}\n`, 'utf8')

import('../task-center-desktop.mjs').catch(error => {
  const text = error instanceof Error ? error.stack || error.message : String(error)
  fs.writeFileSync(path.join(outputDir, 'electron-bootstrap-error.txt'), `${text}\n`, 'utf8')
  console.error(text)
  app.exit(1)
})
