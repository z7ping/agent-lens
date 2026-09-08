import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const bridge = new URL('./workspace-picker.mjs', import.meta.url)
const preload = new URL('./workspace-picker-preload.cjs', import.meta.url)
const bootstrap = new URL('./bootstrap.mjs', import.meta.url)

test('desktop workspace picker keeps renderer sandboxed behind a narrow IPC bridge', async () => {
  const [bridgeSource, preloadSource, bootstrapSource] = await Promise.all([
    readFile(bridge, 'utf8'),
    readFile(preload, 'utf8'),
    readFile(bootstrap, 'utf8'),
  ])
  assert.match(bridgeSource, /registerPreloadScript/)
  assert.match(bridgeSource, /hostname === '127\.0\.0\.1'/)
  assert.match(bridgeSource, /showOpenDialog/)
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('agentLensDesktop'/)
  assert.match(preloadSource, /ipcRenderer\.invoke\('agent-lens:select-workspace'\)/)
  assert.match(bootstrapSource, /await import\('\.\/workspace-picker\.mjs'\)/)
})
