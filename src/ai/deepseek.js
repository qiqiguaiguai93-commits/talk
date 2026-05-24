const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "default.json");
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

let _apiKey = null;

function setApiKey(key) {
  _apiKey = key;
  console.log("[deepseek] API key updated at runtime");
}

function getApiKey() {
  if (_apiKey) return _apiKey;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const cfg = JSON.parse(raw);
      if (typeof cfg.apiKey === "string" && cfg.apiKey) return cfg.apiKey;
    }
  } catch (_) {}
  return null;
}

let _client = null;
let _clientKey = null;

function getClient(apiKey) {
  if (_client && _clientKey === apiKey) return _client;
  _client = new OpenAI({
    baseURL: DEEPSEEK_BASE,
    apiKey,
    timeout: 60000,
    maxRetries: 0,
    defaultHeaders: { "User-Agent": "DeepSeekClient/1.0" },
  });
  _clientKey = apiKey;
  return _client;
}

async function validateKey(token) {
  const tmpClient = new OpenAI({
    baseURL: DEEPSEEK_BASE,
    apiKey: token,
    timeout: 15000,
    maxRetries: 0,
  });
  await tmpClient.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1,
  });
  return true;
}

async function chat(messages, systemPrompt, isThinkMode) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured.");
  const client = getClient(apiKey);

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.9,
        max_tokens: isThinkMode ? 2000 : 600,
      });
      return completion.choices[0].message.content;
    } catch (err) {
      console.error(`[deepseek] chat attempt ${attempt + 1}/${MAX_RETRIES + 1} failed:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }
  throw new Error("网络好像不太稳，等会儿再说吧~");
}

async function* chatStream(messages, systemPrompt, isThinkMode) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API key configured.");
  const client = getClient(apiKey);

  const stream = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.9,
    max_tokens: isThinkMode ? 2000 : 600,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

async function transcribeAudio(base64Audio) {
  const apiKey = getApiKey();
  if (!apiKey) return "";
  try {
    const client = new OpenAI({ baseURL: DEEPSEEK_BASE, apiKey, timeout: 30000, maxRetries: 1 });
    const audioBuf = Buffer.from(base64Audio, "base64");
    const file = new File([audioBuf], "audio.wav", { type: "audio/wav" });
    const result = await client.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: "zh",
    });
    return result.text || "";
  } catch (err) {
    console.error("[deepseek] transcribe error:", err.message);
    return "";
  }
}

module.exports = { setApiKey, getApiKey, validateKey, chat, chatStream, transcribeAudio };
