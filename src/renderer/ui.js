// ========== DOM refs ==========

const settingsPanel = document.getElementById("settings-panel");
const settingsInput = document.getElementById("settings-input");
const settingsBtn = document.getElementById("settings-btn");
const settingsError = document.getElementById("settings-error");
const settingsCloseBtn = document.getElementById("settings-close-btn");
const importHistoryBtn = document.getElementById("import-history-btn");
const chatHistoryFile = document.getElementById("chat-history-file");

const liquidContainer = document.getElementById("liquid-container");
const chatPanel = document.getElementById("chat-panel");
const panelBubbles = document.getElementById("panel-bubbles");
const panelInput = document.getElementById("panel-input");
const panelSend = document.getElementById("panel-send");
const panelMic = document.getElementById("panel-mic");
const panelCollapse = document.getElementById("panel-collapse");
const trayBubble = document.getElementById("tray-bubble");
const trayBubbleText = document.getElementById("tray-bubble-text");

let chatInput = panelInput;
let chatSend = panelSend;

// ========== shared state ==========

let fadeTimer = null;
let autoTimerId = null;
let autoActionPending = false;
let pendingId = 0;
let styleInjected = false;
const injectedMemoryIds = new Set();
const messages = [];

let streamEnabled = localStorage.getItem("streamEnabled") !== "false";
let ttsEnabled = localStorage.getItem("ttsEnabled") !== "false";
let autoChatEnabled = localStorage.getItem("autoChatEnabled") !== "false";

// ========== pet state ==========

function computeTimeSlot() {
  const h = new Date().getHours();
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18 && h < 24) return "evening";
  return "late night";
}

const petState = {
  mode: "chat",
  mood: "happy",
  hunger: 50,
  intimacy: 0,
  lastInteraction: Date.now(),
  get timeSlot() { return computeTimeSlot(); },
};

function buildPetContext() {
  const timeNames = { morning: "morning", afternoon: "afternoon", evening: "evening", "late night": "late night" };
  return `[Current time: ${timeNames[petState.timeSlot]}, mood: ${petState.mood}]`;
}

// ========== panel expand/collapse ==========

function expandPanel() {
  chatPanel.classList.remove("hidden");
  liquidContainer.classList.add("hidden");
  chatInput = panelInput;
  chatSend = panelSend;
  window.electronAPI.setUIMode("panel").catch(() => {});
}

function collapsePanel() {
  chatPanel.classList.add("hidden");
  liquidContainer.classList.remove("hidden");
  window.electronAPI.setUIMode("liquid").catch(() => {});
}

function togglePanel() {
  if (chatPanel.classList.contains("hidden")) {
    expandPanel();
  } else {
    collapsePanel();
  }
}

panelCollapse.addEventListener("click", collapsePanel);

// ========== liquid orb drag ==========

let dragStartX = 0, dragStartY = 0, hasDragged = false;
const DRAG_THRESHOLD = 3;

liquidContainer.addEventListener("mousedown", (e) => {
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  hasDragged = false;

  const onMove = (ev) => {
    const dx = ev.screenX - dragStartX;
    const dy = ev.screenY - dragStartY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      hasDragged = true;
      window.electronAPI.moveWindow(dx, dy);
      dragStartX = ev.screenX;
      dragStartY = ev.screenY;
    }
  };

  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    liquidContainer.style.cursor = "grab";
  };

  liquidContainer.style.cursor = "grabbing";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

liquidContainer.addEventListener("dblclick", () => {
  if (!hasDragged) togglePanel();
});

// ========== bubble display ==========

function showBubble(text, duration) {
  const savedSec = parseInt(localStorage.getItem("bubbleDuration")) || 8;
  duration = duration ?? savedSec * 1000;

  let mode = "chat";
  let displayText = text;

  if (text.startsWith("[思考]")) { mode = "think"; displayText = text.slice(4).trim(); duration = Math.max(duration, 10000); }
  else if (text.startsWith("[闲聊]")) { mode = "chat"; displayText = text.slice(4).trim(); }
  else if (text.startsWith("[主动]")) { mode = "active"; displayText = text.slice(4).trim(); duration = Math.max(duration, 5000); }

  const isPlaceholder = displayText === "...";

  if (chatPanel.classList.contains("hidden") && !isPlaceholder) {
    expandPanel();
  }

  if (!chatPanel.classList.contains("hidden") && !isPlaceholder) {
    const bubble = document.createElement("div");
    bubble.className = "panel-bubble ai";
    if (mode === "think") bubble.style.background = "rgba(44,55,72,0.88)";
    if (mode === "think") bubble.style.color = "#d0d8e8";
    if (mode === "active") bubble.style.background = "rgba(255,250,225,0.9)";
    bubble.textContent = displayText;

    const btn = document.createElement("button");
    btn.style.cssText = "border:none;background:rgba(255,140,66,0.8);cursor:pointer;font-size:12px;color:#fff;margin-left:auto;display:block;margin-top:4px;padding:2px 8px;border-radius:6px";
    btn.textContent = "🔊";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.TTSQueue) { window.TTSQueue.cancel(); window.TTSQueue.enqueue(displayText); }
    });
    bubble.appendChild(btn);

    panelBubbles.appendChild(bubble);
    panelBubbles.scrollTop = panelBubbles.scrollHeight;

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, duration);

    if (ttsEnabled && displayText) window.speakText(displayText);
    return;
  }

  if (!isPlaceholder) {
    const tip = document.createElement("div");
    tip.style.cssText = "position:absolute;top:-42px;left:8px;right:8px;background:rgba(255,255,255,0.92);border-radius:10px;padding:6px 10px;font-size:11px;color:#333;box-shadow:0 2px 8px rgba(0,0,0,0.12);z-index:5";
    tip.textContent = displayText.slice(0, 60) + (displayText.length > 60 ? "..." : "");
    liquidContainer.appendChild(tip);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { if (tip.parentNode) tip.remove(); }, duration);
  }
}

function showTrayBubble(msg) {
  trayBubbleText.textContent = msg;
  trayBubble.classList.remove("hidden");
  setTimeout(() => trayBubble.classList.add("hidden"), 4000);
}

// ========== settings panel ==========

function showPetUI() {
  settingsPanel.classList.add("hidden");
  liquidContainer.classList.remove("hidden");
}

function showSettingsPanel() {
  liquidContainer.classList.add("hidden");
  chatPanel.classList.add("hidden");
  settingsPanel.classList.remove("hidden");
  settingsInput.focus();
}

function toggleSettings() {
  const isOpen = !settingsPanel.classList.contains("hidden");
  if (isOpen) {
    settingsPanel.classList.add("hidden");
    liquidContainer.classList.remove("hidden");
    window.scheduleAutoAction();
  } else {
    clearTimeout(autoTimerId);
    autoTimerId = null;
    liquidContainer.classList.add("hidden");
    chatPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    settingsInput.focus();
  }
}

settingsCloseBtn.addEventListener("click", () => {
  settingsPanel.classList.add("hidden");
  liquidContainer.classList.remove("hidden");
});

async function handleValidateAndSave() {
  const key = settingsInput.value.trim();
  if (!key) { settingsError.textContent = "Please enter an API key."; return; }

  settingsBtn.disabled = true;
  settingsBtn.textContent = "Validating...";
  settingsError.textContent = "";

  try {
    const result = await window.electronAPI.validateAndSaveKey(key);
    if (result.success) {
      showPetUI();
      window.scheduleAutoAction();
      showBubble("*smiles* All set!", 4000);
    } else {
      settingsError.textContent = result.error || "Validation failed.";
    }
  } catch (err) {
    settingsError.textContent = "Connection error: " + err.message;
  } finally {
    settingsBtn.disabled = false;
    settingsBtn.textContent = "Validate & Save";
  }
}

settingsBtn.addEventListener("click", handleValidateAndSave);
settingsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleValidateAndSave();
});

// ========== import chat history ==========

importHistoryBtn.addEventListener("click", () => {
  chatHistoryFile.click();
});

chatHistoryFile.addEventListener("change", () => {
  const file = chatHistoryFile.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      localStorage.setItem("chatHistory", reader.result);
      styleInjected = false;
      showBubble("Chat history imported! " + reader.result.length + " characters loaded.", 4000);
    } catch (err) {
      showBubble("*sighs* Failed to save: " + err.message, 4000);
    }
  };
  reader.onerror = () => {
    showBubble("*sighs* Failed to read the file.", 3000);
  };
  reader.readAsText(file);
  chatHistoryFile.value = "";
});

// ========== settings toggles ==========

const streamToggle = document.getElementById("stream-toggle");
if (streamToggle) {
  streamToggle.checked = streamEnabled;
  streamToggle.addEventListener("change", () => {
    streamEnabled = streamToggle.checked;
    localStorage.setItem("streamEnabled", streamEnabled);
  });
}

const ttsToggle = document.getElementById("tts-toggle");
if (ttsToggle) {
  ttsToggle.checked = ttsEnabled;
  ttsToggle.addEventListener("change", () => {
    ttsEnabled = ttsToggle.checked;
    localStorage.setItem("ttsEnabled", ttsEnabled);
    if (!ttsEnabled && window.TTSQueue) window.TTSQueue.cancel();
  });
}

const autoChatToggle = document.getElementById("auto-chat-toggle");
if (autoChatToggle) {
  autoChatToggle.checked = autoChatEnabled;
  autoChatToggle.addEventListener("change", () => {
    autoChatEnabled = autoChatToggle.checked;
    localStorage.setItem("autoChatEnabled", autoChatEnabled);
    if (autoChatEnabled) {
      window.scheduleAutoAction();
    } else {
      clearTimeout(autoTimerId);
      autoTimerId = null;
    }
  });
}

const bubbleDurationSlider = document.getElementById("bubble-duration-slider");
const bubbleDurationValue = document.getElementById("bubble-duration-value");
if (bubbleDurationSlider) {
  const savedSec = parseInt(localStorage.getItem("bubbleDuration")) || 8;
  bubbleDurationSlider.value = savedSec;
  bubbleDurationValue.textContent = savedSec;
  bubbleDurationSlider.addEventListener("input", () => {
    bubbleDurationValue.textContent = bubbleDurationSlider.value;
    localStorage.setItem("bubbleDuration", bubbleDurationSlider.value);
  });
}

// ========== menu actions ==========

async function showAllMemories() {
  try {
    const memories = await window.electronAPI.getMemories();
    if (!memories || memories.length === 0) {
      showBubble("*scratches head* No memories yet... tell me something about yourself!");
      return;
    }
    const lines = memories.map(
      (m, i) => `${i + 1}. ${m.content}  [${new Date(m.timestamp).toLocaleString()}]`
    );
    showBubble("📋 Memories:\n" + lines.join("\n"), 10000);
  } catch (_) {
    showBubble("*sighs* Failed to load memories.", 3000);
  }
}

async function exportChatHistory() {
  const history = localStorage.getItem("chatHistory") || "";
  const current = messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
  const text = history + "\n\n--- current session ---\n\n" + current;

  try {
    const result = await window.electronAPI.exportChat(text);
    if (result.success) {
      showBubble("*smiles* Chat exported to:\n" + result.path, 6000);
    }
  } catch (err) {
    showBubble("*sighs* Export failed: " + err.message, 3000);
  }
}

async function triggerAutoChat() {
  if (autoActionPending) {
    showBubble("*scratches head* Hold on, still thinking about the last thing...", 3000);
    return;
  }
  showBubble("...", 10000);
  autoActionPending = true;

  try {
    const reply = await window.electronAPI.chat([
      { role: "system", content: window.buildAutoContext() },
      { role: "user", content: "" },
    ], undefined, { mode: "chat" });
    petState.lastInteraction = Date.now();
    showBubble("[主动] " + reply.trim(), 5000);
  } catch (err) {
    showBubble("*sighs* " + err.message, 3000);
  } finally {
    autoActionPending = false;
  }
}

window.electronAPI.onMenuAction((action) => {
  switch (action) {
    case "open-settings": toggleSettings(); break;
    case "trigger-chat": triggerAutoChat(); break;
    case "export-chat": exportChatHistory(); break;
    case "view-memories": showAllMemories(); break;
    case "tray-notify": showTrayBubble("我在系统托盘里，双击我就能回来~"); break;
  }
});

// ========== expose to other modules ==========

window.showBubble = showBubble;
window.expandPanel = expandPanel;
window.collapsePanel = collapsePanel;
window.togglePanel = togglePanel;
window.showPetUI = showPetUI;
window.showSettingsPanel = showSettingsPanel;
window.buildPetContext = buildPetContext;
window.petState = petState;
window.panelBubbles = panelBubbles;
window.chatInput = chatInput;
window.chatSend = chatSend;
window.panelInput = panelInput;
window.panelSend = panelSend;
window.messages = messages;
window.streamEnabled_get = () => streamEnabled;
window.ttsEnabled_get = () => ttsEnabled;
window.autoChatEnabled_get = () => autoChatEnabled;
window.injectedMemoryIds = injectedMemoryIds;
window.styleInjected_get = () => styleInjected;
window.styleInjected_set = (v) => { styleInjected = v; };
window.pendingId_get = () => pendingId;
window.pendingId_inc = () => ++pendingId;
window.settingsPanel = settingsPanel;
window.liquidContainer = liquidContainer;
window.chatPanel = chatPanel;
window.fadeTimer_get = () => fadeTimer;
window.fadeTimer_set = (v) => { fadeTimer = v; };
window.autoTimerId_get = () => autoTimerId;
window.autoTimerId_set = (v) => { autoTimerId = v; };
window.autoActionPending_get = () => autoActionPending;
window.autoActionPending_set = (v) => { autoActionPending = v; };

// ========== startup init ==========

(async function init() {
  console.log("[renderer] init: checking API key status...");

  try {
    const history = await window.electronAPI.getChatHistory();
    if (history && history.trim()) {
      localStorage.setItem("chatHistory", history);
      console.log("[renderer] chat_history.txt loaded (" + history.length + " chars)");
    }
  } catch (_) {}

  try {
    const { hasKey } = await window.electronAPI.getApiKeyStatus();
    if (hasKey) {
      showPetUI();
      window.scheduleAutoAction();
    } else {
      showSettingsPanel();
    }
  } catch (err) {
    console.error("[renderer] init: IPC failed, falling back to settings:", err.message);
    showSettingsPanel();
  }
})();
