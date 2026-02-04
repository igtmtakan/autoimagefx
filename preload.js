const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startAutomation: (count, prompt) => ipcRenderer.send('start-automation', count, prompt),
    stopAutomation: () => ipcRenderer.send('stop-automation'),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', callback),
    onUpdateCount: (callback) => ipcRenderer.on('update-count', callback),
    onAutomationFinished: (callback) => ipcRenderer.on('automation-finished', callback)
});
