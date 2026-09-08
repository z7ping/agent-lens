const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentLensDesktop', {
  selectWorkspace: () => ipcRenderer.invoke('agent-lens:select-workspace'),
})
