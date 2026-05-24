const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getApiKeyStatus: () => ipcRenderer.invoke("get-api-key-status"),
  validateAndSaveKey: (key) => ipcRenderer.invoke("validate-and-save-key", key),
  chat: (messages, apiKey, options) => ipcRenderer.invoke("chat", messages, apiKey, options),
  saveMemory: (content) => ipcRenderer.invoke("save-memory", content),
  getMemories: () => ipcRenderer.invoke("get-memories"),
  searchMemories: (opts) => ipcRenderer.invoke("search-memories", opts),

  getChatHistory: () => ipcRenderer.invoke("get-chat-history"),
  exportChat: (text) => ipcRenderer.invoke("export-chat", text),

  setOpacity: (value) => ipcRenderer.send("set-window-opacity", value),
  moveWindow: (dx, dy) => ipcRenderer.send("move-window", { dx, dy }),
  transcribeAudio: (base64, mimeType) =>
    ipcRenderer.invoke("transcribe-audio", base64, mimeType),
  getAsrBackend: () => ipcRenderer.invoke("get-asr-backend"),
  setAsrBackend: (backend) => ipcRenderer.invoke("set-asr-backend", backend),
  setUIMode: (mode) => ipcRenderer.invoke("set-ui-mode", mode),
  getUIMode: () => ipcRenderer.invoke("get-ui-mode"),
  setMousePassthrough: (enabled) => ipcRenderer.invoke("set-mouse-passthrough", enabled),

  startStreamChat: (messages, apiKey, options) =>
    ipcRenderer.send("chat-stream-start", messages, apiKey, options),

  onStreamToken: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on("chat-stream-token", h);
    return () => ipcRenderer.removeListener("chat-stream-token", h);
  },
  onStreamEnd: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on("chat-stream-end", h);
    return () => ipcRenderer.removeListener("chat-stream-end", h);
  },
  onStreamError: (cb) => {
    const h = (_e, t) => cb(t);
    ipcRenderer.on("chat-stream-error", h);
    return () => ipcRenderer.removeListener("chat-stream-error", h);
  },

  onMenuAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("menu-action", handler);
    return () => ipcRenderer.removeListener("menu-action", handler);
  },
});
