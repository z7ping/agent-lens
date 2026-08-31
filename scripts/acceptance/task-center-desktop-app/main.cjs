const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const outputDir = path.resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'electron-bootstrap.txt'), `started ${new Date().toISOString()}\n`, 'utf8')

// CI 使用隐藏 BrowserWindow，但验收的是正常前台 Desktop 交互。关闭后台节流，避免
// requestAnimationFrame / focus-return 因 hosted runner 的隐藏窗口状态被错误判成产品回归。
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// Windows/Linux 默认会在最后一个窗口关闭时退出。桌面验收会依次销毁 1280、1366
// 截图窗口并另起一个 100 次切换压力窗口，因此必须由验收入口显式持有 App 生命周期。
app.on('window-all-closed', () => {})

import('../task-center-desktop.mjs').catch(error => {
  const text = error instanceof Error ? error.stack || error.message : String(error)
  fs.writeFileSync(path.join(outputDir, 'electron-bootstrap-error.txt'), `${text}\n`, 'utf8')
  console.error(text)
  app.exit(1)
})
