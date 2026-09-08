import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'

const CHANNEL = 'agent-lens:select-workspace'

function isLocalAgentLensPage(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

app.whenReady().then(() => {
  session.defaultSession.registerPreloadScript({
    type: 'frame',
    id: 'agent-lens-desktop-workspace-picker',
    filePath: fileURLToPath(new URL('./workspace-picker-preload.cjs', import.meta.url)),
  })

  ipcMain.handle(CHANNEL, async event => {
    if (!isLocalAgentLensPage(event.senderFrame.url)) {
      throw new Error('Workspace picker is only available to the local AgentLens UI')
    }
    const options = {
      title: '选择 Pi 工作目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })
})
