"""Vosk offline speech recognition.
Receives base64-encoded WAV audio from stdin, returns JSON to stdout.
"""
import sys, json, base64, wave, io, os.path

MODEL_PATH = sys.argv[1] if len(sys.argv) > 1 else "D:/vosk-model-small-cn-0.22/vosk-model-small-cn-0.22"

try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    print(json.dumps({"text": "", "error": "vosk not installed"}))
    sys.exit(0)

_model = None

def get_model():
    global _model
    if _model is None:
        print(json.dumps({"debug": "loading model", "path": MODEL_PATH, "exists": os.path.isdir(MODEL_PATH)}))
        _model = Model(MODEL_PATH)
        print(json.dumps({"debug": "model loaded OK"}))
    return _model

def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        print(json.dumps({"text": "", "error": "no input"}))
        return

    try:
        audio_bytes = base64.b64decode(raw)
    except Exception:
        print(json.dumps({"text": "", "error": "invalid base64"}))
        return

    print(json.dumps({"debug": "audio decoded", "bytes": len(audio_bytes)}), flush=True)

    # Hex dump first 80 bytes to verify single WAV header
    hex_preview = audio_bytes[:80].hex(" ")
    print(json.dumps({"debug": "WAV hex preview (first 80 bytes)", "hex": hex_preview}), flush=True)

    # Verify RIFF header
    if audio_bytes[:4] != b"RIFF":
        print(json.dumps({"text": "", "error": "not a WAV file (missing RIFF header)"}))
        return
    if audio_bytes[8:12] != b"WAVE":
        print(json.dumps({"text": "", "error": "not a WAV file (missing WAVE marker)"}))
        return

    # audio_bytes is a COMPLETE WAV file (44-byte RIFF header + PCM data).
    # Open it directly — do NOT re-wrap.
    wav_io = io.BytesIO(audio_bytes)
    try:
        wf = wave.open(wav_io, "rb")
    except Exception as e:
        print(json.dumps({"text": "", "error": f"bad WAV: {e}"}))
        return

    channels = wf.getnchannels()
    width = wf.getsampwidth()
    rate = wf.getframerate()
    frames = wf.getnframes()
    duration = frames / rate if rate else 0
    print(json.dumps({"debug": "WAV info", "channels": channels, "bits": width * 8, "rate": rate, "frames": frames, "duration_s": round(duration, 2)}), flush=True)

    # Save debug copy
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug_audio.wav"), "wb") as f:
            f.write(audio_bytes)
        print(json.dumps({"debug": "saved debug_audio.wav"}), flush=True)
    except Exception:
        pass

    # Feed to Vosk
    model = get_model()
    rec = KaldiRecognizer(model, rate)
    rec.SetWords(True)

    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        rec.AcceptWaveform(data)

    wf.close()
    result = json.loads(rec.FinalResult())
    text = result.get("text", "")
    print(json.dumps({"text": text}), flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"text": "", "error": str(e)}))
