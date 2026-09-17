import { app, shell } from 'electron'

const REPOSITORY_ORIGIN = 'https://github.com'
const REPOSITORY_PATH = '/z7ping/agent-lens'
const PI_ORIGIN = 'https://pi.dev'
const PI_PACKAGES_PATH = '/packages/'

export function isTrustedAgentLensExternalUrl(value) {
  try {
    const url = new URL(value)
    return (
      url.origin === REPOSITORY_ORIGIN
      && (url.pathname === REPOSITORY_PATH || url.pathname.startsWith(`${REPOSITORY_PATH}/`))
    ) || (
      url.origin === PI_ORIGIN
      && url.pathname.startsWith(PI_PACKAGES_PATH)
    )
  } catch {
    return false
  }
}

app.on('web-contents-created', (_event, webContents) => {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAgentLensExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
})
