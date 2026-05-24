const fs = require("fs");
const path = require("path");
const os = require("os");

const MEMORY_DIR = path.join(os.homedir(), ".desktop-pet");
const MEMORY_PATH = path.join(MEMORY_DIR, "memory.json");
const MEMORY_TMP_PATH = path.join(MEMORY_DIR, "memory.json.tmp");

function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function readAll() {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
    }
    if (fs.existsSync(MEMORY_TMP_PATH)) {
      console.warn("[memory] recovering from temp file");
      const data = JSON.parse(fs.readFileSync(MEMORY_TMP_PATH, "utf-8"));
      fs.renameSync(MEMORY_TMP_PATH, MEMORY_PATH);
      return data;
    }
  } catch (_) {}
  return [];
}

function writeAll(memories) {
  ensureDir();
  fs.writeFileSync(MEMORY_TMP_PATH, JSON.stringify(memories, null, 2), "utf-8");
  fs.renameSync(MEMORY_TMP_PATH, MEMORY_PATH);
}

function save(content, keywords) {
  const memories = readAll();
  if (memories.some((m) => m.content === content)) return null;
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    content,
    keywords: keywords || [],
    timestamp: new Date().toISOString(),
  };
  memories.push(entry);
  writeAll(memories);
  console.log("[memory] saved:", content.slice(0, 50));
  return entry;
}

function tokenize(text) {
  const chars = Array.from((text || "").trim());
  const tokens = [];
  for (const ch of chars) {
    if (/[\s，。！？、…—…\.\,\!\?:\;\"\'\(\)\[\]]/g.test(ch)) continue;
    tokens.push(ch);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    tokens.push(tokens[i] + tokens[i + 1]);
  }
  return [...new Set(tokens)];
}

function search(tokens, excludeIds, limit = 3) {
  const memories = readAll();
  if (!memories.length || !tokens || !tokens.length) return [];
  const excludeSet = new Set(excludeIds || []);
  const scored = memories
    .filter((m) => !excludeSet.has(m.id))
    .map((m) => {
      const matched = (m.keywords || []).filter(
        (kw) => tokens.some((t) => {
          if (t.length < 2) return t === kw;
          return t.includes(kw) || kw.includes(t);
        })
      );
      return { ...m, score: matched.length };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

function extractMemories(text) {
  const re = /:::MEMORY:::(\{[^}]+\})/g;
  const entries = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    try { entries.push(JSON.parse(m[1])); } catch (_) {}
  }
  return {
    cleanText: text.replace(re, "").replace(/\n{2,}/g, "\n").trim(),
    entries,
  };
}

module.exports = { readAll, save, tokenize, search, extractMemories };
