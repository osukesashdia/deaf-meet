const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("captionBridge", {
  onCaption(callback) {
    ipcRenderer.on("caption:new", (_event, data) => callback(data));
  },
  onSettingsUpdate(callback) {
    ipcRenderer.on("settings:update", (_event, data) => callback(data));
  },
  onLiveRhythm(callback) {
    ipcRenderer.on("rhythm:live", (_event, data) => callback(data));
  },
  onEmotionDebug(callback) {
    ipcRenderer.on("emotion:debug", (_event, data) => callback(data));
  },
  onClearCaptions(callback) {
    ipcRenderer.on("caption:clear", callback);
  },
  toggleOverlay() {
    ipcRenderer.send("overlay:toggle");
  },
  reposition(position) {
    ipcRenderer.send("overlay:reposition", position);
  },
  updateSettings(settings) {
    ipcRenderer.send("overlay:settings", settings);
  },
  injectCaption(payload) {
    ipcRenderer.send("caption:inject", payload);
  },
  updateLiveRhythm(payload) {
    ipcRenderer.send("rhythm:update", payload);
  },
  clearCaptions() {
    ipcRenderer.send("caption:clear");
  },
  openSpeechCapture() {
    ipcRenderer.send("speech:openCapture");
  },
  getPort() {
    return ipcRenderer.invoke("server:getPort");
  },
  getStatus() {
    return ipcRenderer.invoke("server:getStatus");
  },
  removeAllListeners(channel) {
    ipcRenderer.removeAllListeners(channel);
  },
});
