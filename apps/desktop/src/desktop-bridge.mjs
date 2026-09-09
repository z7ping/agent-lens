import {
  app,
  BrowserWindow,
  dialog,
  session,
  webContents,
} from 'electron'

const DEFAULT_PORT = 56789
const HOST_PICKER_HEADER = 'X-AgentLens-Host-Picker'
const HOST_PROJECT_DIRECTORY_HEADER = 'X-AgentLens-Host-Project-Directory'
const PROJECT_DIRECTORY_PICKER = 'project-directory'
const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
const trustedOrigin = `http://127.0.0.1:${port}`
const projectDirectoryUrl = `${trustedOrigin}/api/v1/pi-live/project-directory`
let pendingSelection = null

function rendererOrigin(contents) {
  try {
    return new URL(contents.getURL()).origin
  } catch {
    return ''
  }
}

function requestWebContents(details) {
  const direct = details.webContents
  if (direct && !direct.isDestroyed()) return direct
  if (!Number.isInteger(details.webContentsId)) return null
  const contents = webContents.fromId(details.webContentsId)
  if (!contents || contents.isDestroyed()) return null
  return contents
}

function selectProjectDirectory(owner) {
  if (pendingSelection) return pendingSelection
  const options = {
    title: '选择 Pi 项目目录',
    buttonLabel: '选择此目录',
    properties: ['openDirectory'],
  }
  pendingSelection = (owner && !owner.isDestroyed()
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options)
  ).then(result => result.canceled ? undefined : result.filePaths[0])
    .finally(() => { pendingSelection = null })
  return pendingSelection
}

function registerDesktopHostRequests() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [projectDirectoryUrl] },
    (details, callback) => {
      if (details.method !== 'POST') {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      const contents = requestWebContents(details)
      if (!contents || rendererOrigin(contents) !== trustedOrigin) {
        callback({ cancel: true })
        return
      }

      const owner = BrowserWindow.fromWebContents(contents)
      void selectProjectDirectory(owner).then(cwd => {
        const requestHeaders = {
          ...details.requestHeaders,
          [HOST_PICKER_HEADER]: PROJECT_DIRECTORY_PICKER,
          ...(cwd ? { [HOST_PROJECT_DIRECTORY_HEADER]: encodeURIComponent(cwd) } : {}),
        }
        callback({ requestHeaders })
      }, () => callback({ cancel: true }))
    },
  )
}

if (app.isReady()) registerDesktopHostRequests()
else app.once('ready', registerDesktopHostRequests)
