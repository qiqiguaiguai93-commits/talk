const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, Tray, nativeImage } = require("electron");
const { spawn } = require("child_process");
const { WebSocket } = require("ws");
const fs = require("fs");
const path = require("path");

// --------------- paths ---------------

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "default.json");
const WS_URL = "ws://127.0.0.1:5123";
const AI_SERVER_SCRIPT = path.join(__dirname, "..", "ai", "server.js");

// --------------- API key encryption ---------------

function encryptApiKey(plainKey) {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plainKey);
    return { encrypted: true, data: encrypted.toString("base64") };
  }
  console.warn("[main] safeStorage not available — storing API key in plaintext");
  return { encrypted: false, data: plainKey };
}

function decryptApiKey(cfg) {
  if (typeof cfg.apiKey === "string" && cfg.apiKey) {
    console.log("[main] migrating legacy plaintext API key to encrypted storage");
    const result = encryptApiKey(cfg.apiKey);
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey: result }, null, 2), "utf-8"); } catch (_) {}
    return cfg.apiKey;
  }
  if (cfg.apiKey && cfg.apiKey.encrypted && cfg.apiKey.data) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn("[main] safeStorage not available — cannot decrypt stored key");
      return null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(cfg.apiKey.data, "base64"));
    } catch (err) {
      console.error("[main] failed to decrypt API key:", err.message);
      return null;
    }
  }
  return null;
}

// --------------- AI server lifecycle ---------------

let aiProcess = null;
let ws = null;
let wsReady = false;
const pendingRequests = new Map();
let requestIdCounter = 0;

function startAIServer() {
  return new Promise((resolve, reject) => {
    aiProcess = spawn("node", [AI_SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log("[main] ai-server started, PID:", aiProcess.pid);

    let resolved = false;
    let timeoutHandle = null;

    const done = (outcome) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (outcome === "ready") {
        console.log("[main] ai-server ready signal received");
        resolve();
      }
    };

    timeoutHandle = setTimeout(() => {
      console.warn("[main] ai-server did not emit ready signal within 10s — proceeding anyway");
      done("timeout");
    }, 10000);

    aiProcess.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.log("[ai-server]", msg);
      if (msg.includes("listening on")) done("ready");
    });

    aiProcess.stderr.on("data", (data) => {
      console.error("[ai-server:err]", data.toString().trim());
    });

    aiProcess.on("error", (err) => {
      console.error("[main] ai-server spawn error:", err.message);
      reject(err);
    });

    let restarted = false;
    aiProcess.on("exit", (code, signal) => {
      console.log("[main] ai-server exited, code:", code, "signal:", signal);
      aiProcess = null;
      if (!restarted && (code !== 0 || signal !== null)) {
        restarted = true;
        console.log("[main] attempting ai-server restart (one-time)...");
        setTimeout(() => startAIServer().then(connectWS).catch(() => {}), 2000);
      }
    });
  });
}

let reconnectDelay = 1000;
let reconnectCount = 0;

function connectWS() {
  console.log("[main] connecting to ai-server...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    wsReady = true;
    reconnectDelay = 1000;
    reconnectCount = 0;
    console.log("[main] connected to ai-server");
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    handleWSMessage(msg);
  });

  ws.on("close", () => {
    wsReady = false;
    reconnectCount++;
    const delay = Math.min(reconnectDelay, 30000);
    console.log("[main] WS disconnected, reconnecting in %ds (attempt #%d)...", delay / 1000, reconnectCount);
    if (reconnectCount > 5) {
      console.warn("[main] WS reconnected %d times — ai-server may be unstable", reconnectCount);
    }
    setTimeout(connectWS, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on("error", (err) => {
    console.error("[main] WS error:", err.message);
  });
}

function handleWSMessage(msg) {
  const { requestId, type } = msg;

  if (type === "token") {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.win) {
      pending.win.webContents.send("chat-stream-token", msg.content);
    }
    return;
  }

  if (type === "end") {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.win) {
      pending.win.webContents.send("chat-stream-end", msg.fullText);
    }
    if (pending) {
      pending.resolve(msg.fullText);
      pendingRequests.delete(requestId);
    }
    return;
  }

  if (type === "error") {
    const pending = pendingRequests.get(requestId);
    if (pending && pending.win) {
      pending.win.webContents.send("chat-stream-error", msg.message);
    }
    if (pending) {
      pending.reject(new Error(msg.message));
      pendingRequests.delete(requestId);
    }
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (pending) {
    pending.resolve(msg);
    pendingRequests.delete(requestId);
  }
}

function wsSend(data) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestIdCounter;
    pendingRequests.set(requestId, { resolve, reject });
    if (ws && wsReady) {
      ws.send(JSON.stringify({ requestId, ...data }));
    } else {
      reject(new Error("AI server not connected"));
    }
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error("Request timed out"));
      }
    }, 65000);
  });
}

// --------------- IPC handlers ---------------

ipcMain.handle("get-api-key-status", async () => {
  let hasKey = !!process.env.DEEPSEEK_API_KEY;
  if (!hasKey) {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const key = decryptApiKey(cfg);
        if (key) hasKey = true;
      }
    } catch (_) {}
  }
  return { hasKey };
});

ipcMain.handle("validate-and-save-key", async (_event, key) => {
  if (!key || typeof key !== "string" || !key.trim()) {
    return { success: false, error: "API key cannot be empty." };
  }
  try {
    const res = await wsSend({ type: "validate-key", token: key.trim() });
    if (res.success) {
      const encrypted = encryptApiKey(key.trim());
      const configDir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey: encrypted }, null, 2), "utf-8");
      process.env.DEEPSEEK_API_KEY = key.trim();
      if (ws && wsReady) {
        try { ws.send(JSON.stringify({ type: "set-api-key", token: key.trim() })); } catch (_) {}
      }
    }
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("chat", async (_event, messages, apiKeyOverride, options) => {
  try {
    const res = await wsSend({ type: "chat", messages, token: apiKeyOverride, options });
    return res.content || "";
  } catch (err) {
    return "网络好像不太稳，等会儿再说吧~";
  }
});

ipcMain.on("chat-stream-start", (event, messages, apiKeyOverride, options) => {
  const requestId = ++requestIdCounter;
  const win = BrowserWindow.fromWebContents(event.sender);

  pendingRequests.set(requestId, { resolve: () => {}, reject: () => {}, win });

  if (ws && wsReady) {
    ws.send(JSON.stringify({ requestId, type: "chat-stream", messages, token: apiKeyOverride, options }));
  } else {
    win.webContents.send("chat-stream-error", "AI server not connected");
    win.webContents.send("chat-stream-end", "");
    pendingRequests.delete(requestId);
  }

  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      win.webContents.send("chat-stream-error", "Request timed out");
      win.webContents.send("chat-stream-end", "");
      pendingRequests.delete(requestId);
    }
  }, 65000);
});

ipcMain.handle("search-memories", async (_event, opts) => {
  try {
    const res = await wsSend({ type: "search-memories", query: opts.query || "", tokens: opts.tokens, excludeIds: opts.excludeIds });
    return res.data || [];
  } catch (_) { return []; }
});

ipcMain.handle("get-memories", async () => {
  try {
    const res = await wsSend({ type: "get-memories" });
    return res.data || [];
  } catch (_) { return []; }
});

ipcMain.handle("save-memory", async (_event, payload) => {
  try {
    await wsSend({ type: "save-memory", content: payload.content, keywords: payload.keywords });
  } catch (_) {}
});

ipcMain.handle("export-chat", async (_event, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "导出聊天记录",
    defaultPath: "chat_export.txt",
    filters: [{ name: "Text Files", extensions: ["txt"] }],
  });
  if (!canceled && filePath) {
    fs.writeFileSync(filePath, text, "utf-8");
    return { success: true, path: filePath };
  }
  return { success: false };
});

ipcMain.handle("get-chat-history", async () => {
  const historyPath = path.join(PROJECT_ROOT, "chat_history.txt");
  try {
    if (fs.existsSync(historyPath)) return fs.readFileSync(historyPath, "utf-8");
  } catch (_) {}
  return "";
});

ipcMain.handle("transcribe-audio", async (_event, base64, mimeType) => {
  try {
    const res = await wsSend({ type: "transcribe", audio: base64, mimeType });
    return res;
  } catch (err) {
    return { text: "", error: err.message };
  }
});

ipcMain.handle("get-asr-backend", async () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return cfg.asrBackend || "vosk";
    }
  } catch (_) {}
  return "vosk";
});

ipcMain.handle("set-asr-backend", async (_event, backend) => {
  try {
    const configDir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) : {};
    cfg.asrBackend = backend;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
    await wsSend({ type: "set-asr-backend", backend });
    return { success: true, backend };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on("move-window", (event, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

ipcMain.on("set-window-opacity", (event, opacity) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (senderWin) senderWin.setOpacity(opacity);
});

// --------------- window + tray ---------------

const UI_SIZES = {
  liquid: { width: 70, height: 70 },
  panel: { width: 360, height: 500 },
};

let win = null;
let tray = null;
let isQuitting = false;
let currentUIMode = "liquid";
let isPanelExpanded = false;
let mousePassthrough = false;

ipcMain.handle("set-ui-mode", async (_event, mode) => {
  if (!win) return { success: false };
  currentUIMode = mode;
  const s = mode === "panel" ? UI_SIZES.panel : UI_SIZES.liquid;

  if (mode === "panel") {
    isPanelExpanded = true;
    win.setResizable(true);
  } else {
    isPanelExpanded = false;
    win.setResizable(false);
  }

  win.setIgnoreMouseEvents(mousePassthrough, { forward: true });
  win.setSize(s.width, s.height);
  return { success: true, mode };
});

ipcMain.handle("get-ui-mode", async () => ({ mode: currentUIMode }));

ipcMain.handle("set-mouse-passthrough", async (_event, enabled) => {
  mousePassthrough = !!enabled;
  if (win) win.setIgnoreMouseEvents(mousePassthrough, { forward: true });
  return { success: true, enabled: mousePassthrough };
});

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
  }
}

function createTray() {
  const iconPath = path.join(PROJECT_ROOT, "assets", "icons", "pet_idle.png");
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4, 0);
    const fillColor = [66, 140, 255, 255];
    const borderColor = [33, 80, 200, 255];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const off = (y * size + x) * 4;
        const isBorder = x < 2 || x > size - 3 || y < 2 || y > size - 3;
        const c = isBorder ? borderColor : fillColor;
        buf[off] = c[0]; buf[off + 1] = c[1]; buf[off + 2] = c[2]; buf[off + 3] = c[3];
      }
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  tray = new Tray(icon);
  tray.setToolTip("林一");
  tray.on("double-click", toggleWindow);

  const trayMenu = Menu.buildFromTemplate([
    { label: "显示/隐藏", click: toggleWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(trayMenu);
  console.log("[main] tray created");
}

// --------------- app lifecycle ---------------

app.whenReady().then(async () => {
  // Decrypt API key from config
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      const key = decryptApiKey(cfg);
      if (key) {
        process.env.DEEPSEEK_API_KEY = key;
        console.log("[main] API key loaded from config (encrypted=%s)", cfg.apiKey?.encrypted || false);
      }
    }
  } catch (err) {
    console.error("[main] failed to load API key:", err.message);
  }

  // Start AI server
  try {
    await startAIServer();
    setTimeout(connectWS, 500);
  } catch (err) {
    console.error("[main] failed to start ai-server:", err.message);
  }

  win = new BrowserWindow({
    width: UI_SIZES.liquid.width,
    height: UI_SIZES.liquid.height,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  createTray();

  // Right-click context menu
  win.webContents.on("context-menu", () => {
    const menu = Menu.buildFromTemplate([
      { label: "设置", click: () => win.webContents.send("menu-action", "open-settings") },
      { label: "聊聊最近", click: () => win.webContents.send("menu-action", "trigger-chat") },
      { label: "导出聊天记录", click: () => win.webContents.send("menu-action", "export-chat") },
      { type: "separator" },
      { label: "查看记忆", click: () => win.webContents.send("menu-action", "view-memories") },
    ]);
    menu.popup({ window: win });
  });

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      win.webContents.send("menu-action", "tray-notify");
    }
  });
});

app.on("window-all-closed", () => {
  // Don't quit — stay in tray
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  if (aiProcess) {
    console.log("[main] killing ai-server PID:", aiProcess.pid);
    aiProcess.kill();
    aiProcess = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
