// ========== TTS Queue ==========

const TTSQueue = {
  _queue: [],
  _speaking: false,

  enqueue(text) {
    if (!window.speechSynthesis) return;
    const clean = text.replace(/\*[^*]+\*/g, "").trim();
    if (!clean || clean === "..." || clean.length < 2) return;
    this._queue.push(clean);
    if (!this._speaking) this._dequeue();
  },

  _dequeue() {
    if (this._queue.length === 0) {
      this._speaking = false;
      return;
    }
    this._speaking = true;
    const text = this._queue.shift();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.1;
    u.pitch = 1.0;
    u.volume = 1.0;

    u.onend = () => this._dequeue();
    u.onerror = (e) => {
      if (e.error === "interrupted") {
        console.log("[tts] interrupted — expected");
      } else {
        console.error("[tts] error:", e.error);
      }
      setTimeout(() => this._dequeue(), 100);
    };

    window.speechSynthesis.speak(u);
  },

  cancel() {
    this._queue.length = 0;
    this._speaking = false;
    window.speechSynthesis?.cancel();
  },
};

window.TTSQueue = TTSQueue;

function speakText(text) {
  TTSQueue.enqueue(text);
}

window.speakText = speakText;

// ========== ASR: PCM recording + WAV encode ==========

let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

function encodeWAV(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, samples[i] * 0x7FFF)), true);
  }
  return new Uint8Array(buf);
}

let emptyResultCount = 0;

async function stopRecordingAndTranscribe() {
  if (!mediaRecorder) return;
  try {
    const { stream, audioCtx, source, processor } = mediaRecorder;
    processor.disconnect();
    source.disconnect();
    audioCtx.close();
    stream.getTracks().forEach(t => t.stop());
    mediaRecorder = null;

    if (audioChunks.length === 0) return;

    let totalLen = 0;
    for (const c of audioChunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let off = 0;
    for (const c of audioChunks) { merged.set(c, off); off += c.length; }
    audioChunks = [];
    const wav = encodeWAV(merged, 16000);

    let binary = "";
    for (let i = 0; i < wav.byteLength; i++) binary += String.fromCharCode(wav[i]);
    const base64 = btoa(binary);

    const result = await Promise.race([
      window.electronAPI.transcribeAudio(base64, "audio/wav"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);

    const text = typeof result === "string" ? result : result?.text || "";
    if (text && text.trim()) {
      emptyResultCount = 0;
      window.chatInput.value = text;
      setTimeout(() => { if (window.chatInput.value.trim()) window.sendMessage(); }, 400);
    } else {
      emptyResultCount++;
      if (emptyResultCount >= 2) {
        window.showBubble("连续识别为空，请检查麦克风是否正常。", 4000);
        emptyResultCount = 0;
      } else {
        window.showBubble("识别超时，请重试", 3000);
      }
    }
  } catch (err) {
    emptyResultCount++;
    if (err.message === "timeout") {
      window.showBubble("识别超时，请重试", 3000);
    } else {
      window.showBubble("语音识别失败: " + err.message, 4000);
    }
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    audioChunks = [];

    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      audioChunks.push(new Float32Array(input));
    };

    mediaRecorder = { stream, audioCtx, source, processor };

    isRecording = true;
    const mic = document.getElementById("panel-mic");
    if (mic) mic.classList.add("recording");
    const input = document.getElementById("panel-input");
    if (input) input.placeholder = "Listening...";
  } catch (err) {
    console.error("[voice] getUserMedia failed:", err.message);
    if (err.name === "NotAllowedError") {
      window.showBubble("麦克风权限被拒绝，请在系统设置中允许麦克风访问。", 4000);
    } else {
      window.showBubble("无法访问麦克风: " + err.message, 3000);
    }
    stopRecording();
  }
}

function stopRecording() {
  isRecording = false;
  const mic = document.getElementById("panel-mic");
  if (mic) mic.classList.remove("recording");
  const input = document.getElementById("panel-input");
  if (input) input.placeholder = "Say something...";
  stopRecordingAndTranscribe();
}

// ========== mic button handlers ==========

window.addEventListener("DOMContentLoaded", () => {
  const micBtn = document.getElementById("panel-mic");
  if (!micBtn) return;

  micBtn.addEventListener("mousedown", (e) => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener("mouseup", (e) => { e.preventDefault(); stopRecording(); });
  micBtn.addEventListener("mouseleave", (e) => { if (isRecording) { e.preventDefault(); stopRecording(); } });
  micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener("touchend", (e) => { e.preventDefault(); stopRecording(); });
});

// ========== ASR backend dropdown ==========

window.addEventListener("DOMContentLoaded", () => {
  const asrSelect = document.getElementById("asr-backend-select");
  if (!asrSelect) return;

  window.electronAPI.getAsrBackend().then((backend) => {
    asrSelect.value = backend || "vosk";
  }).catch(() => {});

  asrSelect.addEventListener("change", () => {
    const backend = asrSelect.value;
    window.electronAPI.setAsrBackend(backend).then(() => {
      console.log("[asr] backend switched to:", backend);
    }).catch((err) => {
      console.error("[asr] backend switch failed:", err.message);
    });
  });
});

// ========== device check ==========

if (navigator.mediaDevices?.enumerateDevices) {
  navigator.mediaDevices.enumerateDevices().then((devices) => {
    const inputs = devices.filter(d => d.kind === "audioinput");
    console.log("[voice] audio input devices:", inputs.map(d => d.label || "(no label)"));
  }).catch(() => {});
}

// ========== expose to other modules ==========

window.startRecording = startRecording;
window.stopRecording = stopRecording;
window.isRecording_get = () => isRecording;
