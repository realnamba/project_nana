/**
 * Preload script — exposes a small safe API to the renderer (Model manager).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nanaDesktop', {
    /**
     * Open a folder in the OS file manager. Returns an error string if failed, else empty string.
     * @param {string} folderPath
     */
    openModelsFolder: (folderPath) => ipcRenderer.invoke('nana:open-models-folder', folderPath),
    selectFolder: () => ipcRenderer.invoke('nana:select-folder'),
    getDataDir: () => ipcRenderer.invoke('nana:get-data-dir'),
});
