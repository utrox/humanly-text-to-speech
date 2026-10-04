#!/usr/bin/env python3
"""Humanly TTS helper: runs the Kokoro voice natively for the Firefox extension.

Firefox starts this program on demand (native messaging) and talks to it over
stdin/stdout: each message is a 4-byte little-endian length followed by UTF-8 JSON.

In:  {"type":"hello"} | {"type":"load"} | {"type":"synth","id":N,"text":..,"voice":..,"speed":..}
Out: {"type":"hello","version":..} | {"type":"ready","device":"native-gpu"|"native-cpu"} |
     {"type":"note","msg":..} | {"type":"audio","id":N,"sr":24000,"seq":k,"last":bool,"pcm":base64 int16} |
     {"type":"error","id":N|null,"msg":..}

Run with --selftest to check the installation from a terminal.
"""
import base64
import json
import os
import struct
import sys
import time

VERSION = "1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "kokoro-v1.0.onnx")
VOICES = os.path.join(HERE, "voices-v1.0.bin")
# espeak-ng silently ignores data paths longer than ~160-230 characters, and the copy inside
# the Python environment can be that deep. The installer puts a copy at this short path.
ESPEAK_DATA = os.path.join(HERE, "espeak-ng-data")
MAX_PART_SAMPLES = 280_000  # keeps each message well under Firefox's 1 MB limit


def log(*args):
    print("humanly-tts-helper:", *args, file=sys.stderr, flush=True)


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


SELFTEST = "--selftest" in sys.argv


def send(obj):
    if SELFTEST:
        if obj.get("type") == "note":
            print(obj["msg"])
        return
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def check_speech(audio, sr):
    """True when the audio sounds like speech rather than static (same test as the extension)."""
    import numpy as np

    a = np.asarray(audio, dtype=np.float32)
    if a.size == 0 or not np.all(np.isfinite(a)) or np.max(np.abs(a)) < 0.01:
        return False
    zcr = np.count_nonzero(np.diff(np.signbit(a))) / a.size
    frame = max(1, int(sr * 0.02))
    n = a.size // frame
    rms = np.sqrt(np.mean(a[: n * frame].reshape(n, frame) ** 2, axis=1))
    rms.sort()
    dyn = (rms[min(n - 1, int(0.9 * n))] + 1e-4) / (rms[int(0.1 * n)] + 1e-4)
    return zcr < 0.3 and dyn > 4


class Engine:
    def __init__(self):
        self.kokoro = None
        self.device = None

    def load(self):
        if self.kokoro:
            return
        import onnxruntime as rt
        from kokoro_onnx import Kokoro
        from kokoro_onnx.config import EspeakConfig

        espeak = EspeakConfig(data_path=ESPEAK_DATA) if os.path.isdir(ESPEAK_DATA) else None

        if not os.path.exists(MODEL) or not os.path.exists(VOICES):
            raise RuntimeError("the voice model files are missing; run install.bat again")

        available = rt.get_available_providers()
        attempts = []
        if os.environ.get("HUMANLY_TTS_CPU") != "1":
            for gpu in ("CUDAExecutionProvider", "DmlExecutionProvider"):
                if gpu in available:
                    attempts.append(("native-gpu", [gpu, "CPUExecutionProvider"]))
        attempts.append(("native-cpu", ["CPUExecutionProvider"]))

        for device, providers in attempts:
            try:
                so = rt.SessionOptions()
                if providers[0] == "DmlExecutionProvider":
                    so.enable_mem_pattern = False
                    so.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL
                sess = rt.InferenceSession(MODEL, so, providers=providers)
                kokoro = Kokoro.from_session(sess, VOICES, espeak_config=espeak)
                audio, sr = kokoro.create("The quick brown fox jumps over the lazy dog.", voice="af_heart")
                if not check_speech(audio, sr):
                    raise RuntimeError("it produced noise instead of speech")
                self.kokoro, self.device = kokoro, device
                log("voice running on", device, providers[0])
                return
            except Exception as e:  # try the next option
                log("could not use", providers[0], "-", e)
                if device == "native-gpu":
                    send({"type": "note", "msg": f"Graphics card unavailable to the helper ({e}); using the processor."})
                else:
                    raise

    def synth(self, text, voice, speed):
        lang = "en-gb" if voice.startswith("b") else "en-us"
        audio, sr = self.kokoro.create(text, voice=voice, speed=float(speed), lang=lang)
        return audio, sr


def to_parts(audio):
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    parts = [pcm[i : i + MAX_PART_SAMPLES] for i in range(0, max(1, pcm.size), MAX_PART_SAMPLES)]
    return [base64.b64encode(p.tobytes()).decode("ascii") for p in parts]


def serve():
    engine = Engine()
    while True:
        msg = read_message()
        if msg is None:
            return  # Firefox closed the connection
        kind = msg.get("type")
        try:
            if kind == "hello":
                send({"type": "hello", "version": VERSION})
            elif kind == "load":
                engine.load()
                send({"type": "ready", "device": engine.device})
            elif kind == "synth":
                engine.load()
                t0 = time.perf_counter()
                audio, sr = engine.synth(msg["text"], msg.get("voice", "af_heart"), msg.get("speed", 1.0))
                ms = (time.perf_counter() - t0) * 1000
                parts = to_parts(audio)
                for k, data in enumerate(parts):
                    send({"type": "audio", "id": msg["id"], "sr": sr, "seq": k, "last": k == len(parts) - 1,
                          "pcm": data, "ms": ms, "device": engine.device})
        except Exception as e:
            log("error:", repr(e))
            send({"type": "error", "id": msg.get("id"), "msg": str(e)})


def selftest():
    engine = Engine()
    t0 = time.perf_counter()
    engine.load()
    print(f"Loaded the voice on {engine.device} in {time.perf_counter() - t0:.1f} s")
    text = "If you can hear this sentence clearly, the Humanly TTS helper is working."
    t0 = time.perf_counter()
    audio, sr = engine.synth(text, "af_heart", 1.0)
    dt = time.perf_counter() - t0
    print(f"Made {len(audio) / sr:.1f} s of speech in {dt:.2f} s")
    try:
        import winsound
        import wave
        path = os.path.join(HERE, "selftest.wav")
        import numpy as np
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        winsound.PlaySound(path, winsound.SND_FILENAME)
    except ImportError:
        pass


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        serve()
