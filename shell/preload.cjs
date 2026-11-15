const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshShell', {
  minimize: () => ipcRenderer.send('shell:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:window', 'toggle-maximize'),
  close: () => ipcRenderer.send('shell:window', 'close'),
  back: () => ipcRenderer.send('shell:back'),
  isMaximized: () => ipcRenderer.sendSync('shell:window:state'),
  onMaximizeChange: (callback) => {
    const listener = (_event, value) => {
      try {
        callback(Boolean(value))
      } catch {
        /* ignored */
      }
    }
    ipcRenderer.on('shell:maximized', listener)
    return () => ipcRenderer.removeListener('shell:maximized', listener)
  },
})
