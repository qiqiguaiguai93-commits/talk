// ========== memory helpers ==========

function extractMemories(text) {
  const re = /:::MEMORY:::(\{[^}]+\})/g;
  const entries = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    try { entries.push(JSON.parse(m[1])); } catch (_) {}
  }
  return {
    cleanText: text.replace(re, "").replace(/\n{2,}/g, "\n").trim(),
    memoryEntries: entries,
  };
}

async function searchMemories(query) {
  try {
    return await window.electronAPI.searchMemories({ query, excludeIds: [...window.injectedMemoryIds] });
  } catch (_) { return []; }
}

// ========== reply finalization (shared by stream + non-stream) ==========

function finalizeReply(replyText, msgs, transientMsgs, userMsg) {
  const { cleanText, memoryEntries } = extractMemories(replyText);
  for (const entry of memoryEntries) {
    window.electronAPI.saveMemory({ content: entry.content, keywords: entry.keywords || [] }).catch(() => {});
  }
  msgs.push(...transientMsgs, userMsg, { role: "assistant", content: cleanText });
  window.showBubble(cleanText);
  if (window.ttsEnabled_get()) window.speakText(cleanText);
}

// ========== transient message builders ==========

function cleanAutoSystemMessages(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content;
    if (msgs[i].role === "system" && (c.startsWith("[AUTO:mode]") || c.startsWith("[AUTO:memory]"))) {
      msgs.splice(i, 1);
    }
  }
}

async function buildTransientMessages(text) {
  const transientMsgs = [];

  if (window.petState.mode === "think") {
    transientMsgs.push({
      role: "system",
      content: "[AUTO:mode] Current mode: think. Please analyze carefully and give a detailed answer.",
    });
  }

  const matchedMemories = await searchMemories(text);
  if (matchedMemories.length > 0) {
    const lines = matchedMemories.map((m, i) => `${i + 1}. ${m.content}`);
    transientMsgs.push({
      role: "system",
      content: "[AUTO:memory] You remember these things about your friend:\n" + lines.join("\n"),
    });
    matchedMemories.forEach((m) => window.injectedMemoryIds.add(m.id));
  }

  // Reset injection tracking when all memories have been shown
  try {
    const all = await window.electronAPI.getMemories();
    if (all.length > 0 && window.injectedMemoryIds.size >= all.length) {
      window.injectedMemoryIds.clear();
    }
  } catch (_) {}

  return transientMsgs;
}

function injectChatStyle() {
  if (window.styleInjected_get()) return;
  const chatHistory = localStorage.getItem("chatHistory");
  if (chatHistory) {
    window.messages.unshift({
      role: "user",
      content: "以下是你（林一）过去的聊天记录，请模仿其中的语气、用词和风格：\n" + chatHistory,
    });
  }
  window.styleInjected_set(true);
}

// ========== streaming helpers ==========

function startStreamReply(requestMessages, myId, transientMsgs, userMsg) {
  let streamedText = "";
  const cleanups = [];
  const cleanup = () => cleanups.forEach((fn) => fn());

  cleanups.push(
    window.electronAPI.onStreamToken((token) => {
      if (myId !== window.pendingId_get()) { cleanup(); return; }
      streamedText += token;
    })
  );

  cleanups.push(
    window.electronAPI.onStreamEnd((fullText) => {
      cleanup();
      if (myId !== window.pendingId_get()) return;
      finalizeReply(fullText || streamedText, window.messages, transientMsgs, userMsg);
    })
  );

  cleanups.push(
    window.electronAPI.onStreamError((msg) => {
      cleanup();
      if (myId !== window.pendingId_get()) return;
      window.showBubble(streamedText || msg, 5000);
    })
  );

  window.electronAPI.startStreamChat(requestMessages, undefined, { mode: window.petState.mode });
}

// ========== send message (orchestrator) ==========

async function sendMessage() {
  const input = window.chatInput;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  window.petState.lastInteraction = Date.now();
  const myId = window.pendingId_inc();

  injectChatStyle();
  cleanAutoSystemMessages(window.messages);

  const transientMsgs = await buildTransientMessages(text);
  const userMsg = { role: "user", content: window.buildPetContext() + "\n" + text };
  const requestMessages = [...window.messages, ...transientMsgs, userMsg];

  window.showBubble("...", 30000);

  if (window.streamEnabled_get()) {
    startStreamReply(requestMessages, myId, transientMsgs, userMsg);
  } else {
    try {
      const reply = await window.electronAPI.chat(requestMessages, undefined, { mode: window.petState.mode });
      if (myId !== window.pendingId_get()) return;
      finalizeReply(reply, window.messages, transientMsgs, userMsg);
    } catch (err) {
      if (myId !== window.pendingId_get()) return;
      window.showBubble("*sighs* Something went wrong: " + err.message);
    }
  }
}

// Wire up send button and Enter key
window.addEventListener("DOMContentLoaded", () => {
  const panelSend = document.getElementById("panel-send");
  const panelInput = document.getElementById("panel-input");
  if (panelSend) panelSend.addEventListener("click", sendMessage);
  if (panelInput) {
    panelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }
});

// ========== auto chat ==========

const FRIEND_STATUS = {
  morning: "刚起床", afternoon: "工作中", evening: "休息中", "late night": "已睡觉",
};

const AUTO_CATEGORIES = { cute: 0.30, reminder: 0.25, work: 0.20, knowledge: 0.25 };

const KNOWLEDGE_FACTS = [
  "Ctrl+Shift+T 可以一键恢复刚刚关掉的浏览器标签页。",
  "20-20-20 护眼法则：每看屏幕 20 分钟，向 20 英尺（约 6 米）外看 20 秒。",
  "世界上第一个真正的电脑 bug 是 1947 年一只卡在继电器里的飞蛾。",
  "每小时站起来活动 2 分钟，就能显著降低久坐带来的健康风险。",
  "番茄工作法：25 分钟专注 + 5 分钟休息，每四个循环后休息 15-30 分钟。",
  "大多数人需要 7-9 小时睡眠，少于 6 小时会严重影响认知能力。",
  "小黄鸭调试法：把代码逻辑讲给一个不会说话的物体听，问题往往自己就浮现了。",
  "屏幕蓝光会抑制褪黑素分泌，睡前记得开启夜间模式。",
];

function pickAutoCategory() {
  const rand = Math.random();
  let cumulative = 0;
  for (const [key, weight] of Object.entries(AUTO_CATEGORIES)) {
    cumulative += weight;
    if (rand < cumulative) return key;
  }
  return "cute";
}

function buildBaseStateInfo() {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `[Time: ${timeStr}, mood: ${window.petState.mood}, hunger: ${window.petState.hunger}/100, intimacy: ${window.petState.intimacy}/100]`;
}

function buildCuteContext() {
  const slot = window.petState.timeSlot;
  const friend = FRIEND_STATUS[slot];
  return buildBaseStateInfo() + " " +
    `Friend status: ${friend}. Mood: happy. ` +
    `Please speak naturally as 林一 — one sentence or one action in *...*.`;
}

function buildReminderContext() {
  const h = new Date().getHours();
  let reminder = "";
  if (h >= 6 && h < 9) reminder = "suggest your friend drink water and stretch to start the day";
  else if (h >= 11 && h < 13) reminder = "remind your friend it's lunchtime";
  else if (h >= 14 && h < 16) reminder = "suggest the 20-20-20 eye rest rule";
  else if (h >= 17 && h < 19) reminder = "suggest your friend take a walk or grab dinner";
  else if (h >= 22 && h < 24) reminder = "gently remind your friend it's late — time to sleep";
  else if (h >= 0 && h < 6) reminder = "express concern your friend is still awake — urge sleep";
  else reminder = "give a friendly health or productivity reminder";
  return buildBaseStateInfo() + " " +
    `[Auto category: time reminder — ${reminder}.] Speak naturally as 林一. 1-2 sentences.`;
}

function buildWorkContext() {
  const prompts = [
    "offer to help your friend organize their thoughts or make a to-do list",
    "suggest a short break and ask how the current task is going",
    "share a productivity tip in a casual way",
    "ask what project they're working on and offer encouragement",
  ];
  const pick = prompts[Math.floor(Math.random() * prompts.length)];
  return buildBaseStateInfo() + " " +
    `[Auto category: work check-in — ${pick}.] Speak naturally as 林一. 1-2 sentences.`;
}

function buildKnowledgeContext() {
  const fact = KNOWLEDGE_FACTS[Math.floor(Math.random() * KNOWLEDGE_FACTS.length)];
  return buildBaseStateInfo() + " " +
    `[Auto category: share a fun fact — casually share: "${fact}"] ` +
    `Speak as 林一. Start with "嘿你知道吗..." or "话说...". 1-2 sentences.`;
}

function buildAutoContext() {
  const category = pickAutoCategory();
  switch (category) {
    case "reminder": return buildReminderContext();
    case "work": return buildWorkContext();
    case "knowledge": return buildKnowledgeContext();
    default: return buildCuteContext();
  }
}

function scheduleAutoAction() {
  if (!window.autoChatEnabled_get()) return;

  const minutes = 3 + Math.random() * 7;
  const delay = minutes * 60 * 1000;

  window.autoTimerId_set(setTimeout(async () => {
    if (!window.autoChatEnabled_get()) return;
    if (!window.settingsPanel.classList.contains("hidden")) {
      scheduleAutoAction();
      return;
    }
    if (window.autoActionPending_get()) {
      scheduleAutoAction();
      return;
    }

    window.autoActionPending_set(true);

    try {
      const reply = await window.electronAPI.chat([
        { role: "system", content: buildAutoContext() },
        { role: "user", content: "" },
      ], undefined, { mode: "chat" });
      window.petState.lastInteraction = Date.now();
      window.showBubble("[主动] " + reply.trim(), 5000);
    } catch (err) {
      console.error("[auto] failed:", err.message);
    } finally {
      window.autoActionPending_set(false);
    }

    scheduleAutoAction();
  }, delay));
}

// ========== expose to other modules ==========

window.sendMessage = sendMessage;
window.buildAutoContext = buildAutoContext;
window.scheduleAutoAction = scheduleAutoAction;
