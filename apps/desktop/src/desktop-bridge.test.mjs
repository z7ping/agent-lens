import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bootstrapPath = fileURLToPath(new URL('./bootstrap.mjs', import.meta.url))
const bridgePath = fileURLToPath(new URL('./desktop-bridge.mjs', import.meta.url))

test('Desktop 在主窗口创建前注册宿主请求适配', async () => {
  const bootstrap = await readFile(bootstrapPath, 'utf8')
  const bridgeImport = bootstrap.indexOf("await import('./desktop-bridge.mjs')")
  const mainImport = bootstrap.indexOf("await import('./main.mjs')")
  assert.ok(bridgeImport >= 0)
  assert.ok(mainImport > bridgeImport)
})

test('Desktop 只接管项目目录 API，并由 Electron 主进程持有原生选择器', async () => {
  const bridge = await readFile(bridgePath, 'utf8')
  assert.match(bridge, /\/api\/v1\/pi-live\/project-directory/)
  assert.match(bridge, /webRequest\.onBeforeSendHeaders/)
  assert.match(bridge, /details\.webContents/)
  assert.match(bridge, /webContents\.fromId\(details\.webContentsId\)/)
  assert.match(bridge, /rendererOrigin\(contents\) !== trustedOrigin/)
  assert.match(bridge, /BrowserWindow\.fromWebContents\(contents\)/)
  assert.match(bridge, /dialog\.showOpenDialog/)
  assert.match(bridge, /properties: \['openDirectory'\]/)
  assert.match(bridge, /X-AgentLens-Host-Picker/)
  assert.match(bridge, /X-AgentLens-Host-Project-Directory/)
  assert.match(bridge, /encodeURIComponent\(cwd\)/)
})

test('Desktop 不向 Web 暴露 Electron IPC 或 preload API', async () => {
  const bridge = await readFile(bridgePath, 'utf8')
  assert.doesNotMatch(bridge, /contextBridge|ipcRenderer|ipcMain|registerPreloadScript/)
})
