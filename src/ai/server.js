const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const deepseek = require("./deepseek");
const memory = require("./memory");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PORT = 5123;
const HOST = "127.0.0.1";
const PROMPT_PATH = path.join(PROJECT_ROOT, "prompt.txt");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "default.json");

// Vosk config
const VOSK_MODEL_PATH = process.env.VOSK_MODEL_PATH || "D:/vosk-model-small-cn-0.22/vosk-model-small-cn-0.22";
const TRANSCRIBE_SCRIPT = path.join(PROJECT_ROOT, "transcribe.py");

// --------------- system prompt ---------------

let systemPrompt = "";
try { systemPrompt = fs.readFileSync(PROMPT_PATH, "utf-8"); } catch (_) {
  console.error("[server] WARNING: prompt.txt not found at", PROMPT_PATH);
}

// --------------- ASR backend ---------------

function getAsrBackend() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return cfg.asrBackend || "vosk";
    }
  } catch (_) {}
  return "vosk";
}

let asrBackend = getAsrBackend();

// --------------- Vosk transcription ---------------

function transcribeVosk(base64Audio) {
  return new Promise((resolve) => {
    const py = spawn("python", [TRANSCRIBE_SCRIPT, VOSK_MODEL_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => { stdout += d.toString(); });
    py.stderr.on("data", (d) => { stderr += d.toString(); });
    py.on("close", (code) => {
      if (stderr) {
        const errLines = stderr.trim().split("\n").filter(l => !l.includes("LOG (VoskAPI") && !l.includes("INFO"));
        if (errLines.length) console.error("[server] vosk stderr:", errLines.join("\n"));
      }
      const lines = stdout.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if ("text" in obj) { resolve(obj.text || ""); return; }
        } catch (_) {}
      }
      resolve("");
    });
    py.on("error", (err) => { console.error("[server] vosk spawn err:", err.message); resolve(""); });
    py.stdin.write(base64Audio);
    py.stdin.end();
  });
}

async function transcribeAudio(base64Audio, _mimeType) {
  const t0 = Date.now();
  console.log("[server] transcribe started, backend:", asrBackend, "bytes:", base64Audio?.length || 0);
  let result;
  if (asrBackend === "deepseek") {
    result = await deepseek.transcribeAudio(base64Audio);
  } else {
    result = await transcribeVosk(base64Audio);
  }
  console.log("[server] transcribe done in", Date.now() - t0, "ms, text:", (result || "").slice(0, 50) || "(empty)");
  return result;
}

// --------------- helpers ---------------

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

// --------------- WebSocket server ---------------

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("listening", () => {
  console.log(`[server] listening on ws://${HOST}:${PORT}`);
  if (asrBackend === "vosk") {
    if (fs.existsSync(VOSK_MODEL_PATH)) {
      console.log("[server] Vosk model found at:", VOSK_MODEL_PATH);
    } else {
      console.warn("[server] Vosk model NOT found at:", VOSK_MODEL_PATH);
    }
  }
});

wss.on("error", (err) => {
  console.error("[server] server error:", err.message);
  process.exit(1);
});

wss.on("connection", (ws) => {
  console.log("[server] client connected");

  ws.on("message", async (raw) => {
    let req;
    try { req = JSON.parse(raw.toString()); } catch (_) { return; }

    const { requestId, type } = req;

    try {
      switch (type) {
        case "validate-key": {
          try {
            await deepseek.validateKey(req.token);
            send(ws, { requestId, type: "validation-result", success: true });
          } catch (err) {
            send(ws, {
              requestId, type: "validation-result", success: false,
              error: err.status === 401 ? "Invalid API key." : err.message,
            });
          }
          break;
        }

        case "chat": {
          const isThink = req.options && req.options.mode === "think";
          const reply = await deepseek.chat(req.messages, systemPrompt, isThink);
          const { cleanText, entries } = memory.extractMemories(reply);
          for (const e of entries) memory.save(e.content, e.keywords || []);
          send(ws, { requestId, type: "reply", content: cleanText });
          break;
        }

        case "chat-stream": {
          const isThink = req.options && req.options.mode === "think";
          let fullText = "";
          try {
            for await (const delta of deepseek.chatStream(req.messages, systemPrompt, isThink)) {
              fullText += delta;
              send(ws, { requestId, type: "token", content: delta });
            }
            const { cleanText, entries } = memory.extractMemories(fullText);
            for (const e of entries) memory.save(e.content, e.keywords || []);
            send(ws, { requestId, type: "end", fullText: cleanText });
          } catch (err) {
            console.error("[server] stream error:", err.message);
            send(ws, { requestId, type: "error", message: "网络好像不太稳，消息断了..." });
            send(ws, { requestId, type: "end", fullText });
          }
          break;
        }

        case "search-memories": {
          const results = memory.search(req.tokens, req.excludeIds, 3);
          send(ws, { requestId, type: "memories", data: results });
          break;
        }

        case "get-memories": {
          send(ws, { requestId, type: "memories", data: memory.readAll() });
          break;
        }

        case "save-memory": {
          memory.save(req.content, req.keywords || []);
          send(ws, { requestId, type: "saved" });
          break;
        }

        case "set-api-key": {
          deepseek.setApiKey(req.token);
          send(ws, { requestId, type: "key-updated" });
          break;
        }

        case "set-asr-backend": {
          asrBackend = req.backend || "vosk";
          try {
            const configDir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) : {};
            cfg.asrBackend = asrBackend;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
          } catch (_) {}
          console.log("[server] ASR backend switched to:", asrBackend);
          send(ws, { requestId, type: "asr-backend-set", backend: asrBackend });
          break;
        }

        case "transcribe": {
          const text = await transcribeAudio(req.audio, req.mimeType);
          send(ws, { requestId, type: "transcription", text });
          break;
        }

        default:
          send(ws, { requestId, type: "error", message: "Unknown request type: " + type });
      }
    } catch (err) {
      console.error("[server] handler error:", err.message);
      send(ws, { requestId, type: "error", message: err.message });
    }
  });

  ws.on("close", () => console.log("[server] client disconnected"));
});
