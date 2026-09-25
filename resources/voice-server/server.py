#!/usr/bin/env python3
"""
Stitch Voice — a small local HTTP server around Qwen3-TTS (Apache-2.0).

    python server.py --port 7862                 # serve
    python server.py --download base-1.7b        # fetch a model into HF_HOME and exit

JSON in, WAV bytes out. Everything binds to 127.0.0.1 by default.

  GET  /health             device, loaded models, state, which models are on disk
  GET  /speakers           CustomVoice preset speakers
  GET  /languages          supported languages
  POST /tts                {text, language, ref_audio, ref_text, x_vector_only, speaker, instruct, design, size, seed}
                           ref_audio → voice clone (Base), design → VoiceDesign, else CustomVoice speaker
  POST /design             {text, instruct, language, seed}  → VoiceDesign
  POST /v1/audio/speech    OpenAI-compatible {model, input, voice, instructions, response_format}
  GET  /v1/models          OpenAI-compatible model list
  POST /download           {model}  download weights without loading them
  POST /unload             free all VRAM
  POST /shutdown           stop the server

Models load lazily on first use, at most --max-resident stay in VRAM, and they
are unloaded after --idle-unload seconds without use. GPU work is serialised.
Progress lines go to stdout; lines starting with "@@state" are machine-readable
status for Stitch (state + optional detail).
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import os
import re
import sys
import threading
import time
import traceback
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

VERSION = "1.0.0"

MODELS: Dict[str, Dict[str, str]] = {
    "base-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "type": "base", "label": "Voice clone 1.7B"},
    "base-0.6b": {"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "type": "base", "label": "Voice clone 0.6B"},
    "custom-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "type": "custom", "label": "Preset speakers 1.7B"},
    "custom-0.6b": {"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "type": "custom", "label": "Preset speakers 0.6B"},
    "design-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "type": "design", "label": "Voice design 1.7B"},
}

SPEAKERS: List[Dict[str, str]] = [
    {"id": "Ryan", "description": "Dynamic male voice with strong rhythmic drive", "language": "English", "gender": "male"},
    {"id": "Aiden", "description": "Sunny American male voice with a clear midrange", "language": "English", "gender": "male"},
    {"id": "Vivian", "description": "Bright, slightly edgy young female voice", "language": "Chinese", "gender": "female"},
    {"id": "Serena", "description": "Warm, gentle young female voice", "language": "Chinese", "gender": "female"},
    {"id": "Uncle_Fu", "description": "Seasoned male voice with a low, mellow timbre", "language": "Chinese", "gender": "male"},
    {"id": "Dylan", "description": "Youthful Beijing male voice with a clear, natural timbre", "language": "Chinese (Beijing)", "gender": "male"},
    {"id": "Eric", "description": "Lively Chengdu male voice with a slightly husky brightness", "language": "Chinese (Sichuan)", "gender": "male"},
    {"id": "Ono_Anna", "description": "Playful Japanese female voice with a light, nimble timbre", "language": "Japanese", "gender": "female"},
    {"id": "Sohee", "description": "Warm Korean female voice with rich emotion", "language": "Korean", "gender": "female"},
]

LANGUAGES = ["Auto", "English", "Chinese", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]

DEFAULT_SPEAKER = {"English": "Ryan", "Chinese": "Vivian", "Japanese": "Ono_Anna", "Korean": "Sohee"}

# OpenAI voice names → closest preset speaker, for /v1/audio/speech clients.
OPENAI_VOICE_MAP = {
    "alloy": "Aiden", "ash": "Ryan", "ballad": "Ryan", "coral": "Serena", "echo": "Aiden", "fable": "Ryan",
    "nova": "Vivian", "onyx": "Uncle_Fu", "sage": "Serena", "shimmer": "Vivian", "verse": "Aiden",
    "marin": "Serena", "cedar": "Ryan",
}

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".webm"}


def log(msg: str) -> None:
    print(f"[voice] {msg}", flush=True)


def state(name: str, detail: str = "") -> None:
    print(f"@@state {name} {detail}".rstrip(), flush=True)


# ─── Text chunking ───────────────────────────────────────────────────────────

_SENTENCE_END = re.compile(r"(?<=[.!?…。！？])[\"'”’)\]]*\s+")


def split_text(text: str, max_chars: int = 260) -> List[Tuple[str, float]]:
    """Split long text into (chunk, pause-after-seconds) pieces on sentence boundaries."""
    out: List[Tuple[str, float]] = []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    for pi, para in enumerate(paragraphs):
        para = re.sub(r"\s+", " ", para)
        sentences = [s.strip() for s in _SENTENCE_END.split(para) if s.strip()]
        pieces: List[str] = []
        for s in sentences:
            if len(s) <= max_chars:
                pieces.append(s)
                continue
            # Very long sentence: break on clause punctuation, then on words.
            buf = ""
            for part in re.split(r"(?<=[,;:，；：—])\s*", s):
                if len(buf) + len(part) + 1 <= max_chars:
                    buf = f"{buf} {part}".strip()
                else:
                    if buf:
                        pieces.append(buf)
                    while len(part) > max_chars:
                        cut = part.rfind(" ", 0, max_chars)
                        cut = cut if cut > max_chars // 3 else max_chars
                        pieces.append(part[:cut].strip())
                        part = part[cut:].strip()
                    buf = part
            if buf:
                pieces.append(buf)
        # Greedily merge short sentences so each generation has enough context.
        merged: List[str] = []
        for p in pieces:
            if merged and len(merged[-1]) + len(p) + 1 <= max_chars:
                merged[-1] = f"{merged[-1]} {p}"
            else:
                merged.append(p)
        for mi, m in enumerate(merged):
            last_in_para = mi == len(merged) - 1
            pause = 0.45 if last_in_para and pi < len(paragraphs) - 1 else 0.14
            out.append((m, pause))
    if out:
        out[-1] = (out[-1][0], 0.0)
    return out


# ─── Audio helpers ───────────────────────────────────────────────────────────


def wav_bytes(samples: Any, sr: int) -> bytes:
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm)
    return buf.getvalue()


def save_temp_audio(b64: str, ext: str) -> str:
    """Write an uploaded reference clip to a content-addressed temp file (stable cache key)."""
    import base64
    import hashlib
    import tempfile

    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    ext = ext if ext.startswith(".") else f".{ext}"
    if ext.lower() not in AUDIO_EXTS:
        ext = ".wav"
    d = os.path.join(tempfile.gettempdir(), "stitch-voice-refs")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, hashlib.sha1(data).hexdigest() + ext)
    if not os.path.isfile(path):
        with open(path, "wb") as f:
            f.write(data)
    return path


def pcm_bytes(samples: Any) -> bytes:
    import numpy as np

    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    return (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def normalize(x: Any) -> Any:
    import numpy as np

    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak <= 1e-4:
        return x
    gain = min(0.93 / peak, 4.0)
    return (x * gain).astype(np.float32)


# ─── Engine ──────────────────────────────────────────────────────────────────


class Engine:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.gpu_lock = threading.Lock()  # one GPU job at a time
        self.meta_lock = threading.Lock()  # protects the fields below
        self.resident: "OrderedDict[str, Any]" = OrderedDict()
        self.last_used: Dict[str, float] = {}
        self.prompt_cache: "OrderedDict[Tuple, Any]" = OrderedDict()
        self.state = "idle"
        self.detail = ""
        self.torch = None
        self.device = "cpu"
        self.device_name = "CPU"
        self.dtype = None
        self.attn: Optional[str] = None
        self.vram_total = 0

    # ── setup ──
    def boot(self) -> None:
        log("Importing PyTorch…")
        import torch  # noqa: WPS433 (heavy import kept lazy for --help)

        self.torch = torch
        want = self.args.device
        if want == "auto":
            want = "cuda:0" if torch.cuda.is_available() else "cpu"
        self.device = want
        if want.startswith("cuda"):
            idx = int(want.split(":")[1]) if ":" in want else 0
            props = torch.cuda.get_device_properties(idx)
            self.device_name = props.name
            self.vram_total = int(props.total_memory)
            self.dtype = getattr(torch, self.args.dtype)
            visible = os.environ.get("CUDA_VISIBLE_DEVICES", "all")
            log(f"Using {props.name} ({props.total_memory / 1024**3:.1f} GB) · CUDA_VISIBLE_DEVICES={visible} · torch {torch.__version__}")
        else:
            self.dtype = torch.float32
            log(f"No CUDA device available — running on CPU (slow). torch {torch.__version__}")
        if not self.args.no_flash_attn and self.device.startswith("cuda"):
            try:
                import flash_attn  # noqa: F401

                self.attn = "flash_attention_2"
                log("FlashAttention 2 available")
            except Exception:
                self.attn = None

    def set_state(self, name: str, detail: str = "") -> None:
        with self.meta_lock:
            self.state = name
            self.detail = detail
        state(name, detail)

    # ── model management ──
    def _unload(self, key: str) -> None:
        model = self.resident.pop(key, None)
        self.last_used.pop(key, None)
        for k in [k for k in self.prompt_cache if k[0] == key]:
            self.prompt_cache.pop(k, None)
        del model
        gc.collect()
        if self.torch is not None and self.device.startswith("cuda"):
            self.torch.cuda.empty_cache()
        log(f"Unloaded {MODELS[key]['label']}")

    def unload_all(self) -> None:
        with self.gpu_lock:
            for key in list(self.resident.keys()):
                self._unload(key)
            self.set_state("idle")

    def ensure_downloaded(self, key: str) -> str:
        repo = MODELS[key]["repo"]
        path = cached_snapshot(repo)
        if path:
            return path
        self.set_state("downloading", key)
        log(f"Downloading {repo} (first use — a few GB, only once)…")
        path = download(repo)
        log(f"Downloaded {repo}")
        return path

    def model(self, key: str) -> Any:
        """Return a loaded model; caller must hold gpu_lock."""
        if key in self.resident:
            self.resident.move_to_end(key)
            self.last_used[key] = time.time()
            return self.resident[key]
        while len(self.resident) >= max(1, self.args.max_resident):
            oldest = next(iter(self.resident))
            self._unload(oldest)
        path = self.ensure_downloaded(key)
        self.set_state("loading-model", key)
        log(f"Loading {MODELS[key]['label']} onto {self.device}…")
        t0 = time.time()
        from qwen_tts import Qwen3TTSModel

        kwargs: Dict[str, Any] = {"device_map": self.device, "dtype": self.dtype}
        if self.attn:
            kwargs["attn_implementation"] = self.attn
        try:
            m = Qwen3TTSModel.from_pretrained(path, **kwargs)
        except Exception as err:  # OOM → drop everything else and retry once
            if "out of memory" in str(err).lower() and self.resident:
                log("Out of VRAM — unloading other voice models and retrying")
                for k in list(self.resident.keys()):
                    self._unload(k)
                m = Qwen3TTSModel.from_pretrained(path, **kwargs)
            elif self.attn and "flash" in str(err).lower():
                log("FlashAttention failed to initialise — falling back to default attention")
                self.attn = None
                kwargs.pop("attn_implementation", None)
                m = Qwen3TTSModel.from_pretrained(path, **kwargs)
            else:
                raise
        self.resident[key] = m
        self.last_used[key] = time.time()
        log(f"Loaded {MODELS[key]['label']} in {time.time() - t0:.1f}s")
        return m

    def idle_sweeper(self) -> None:
        limit = self.args.idle_unload
        if limit <= 0:
            return
        while True:
            time.sleep(15)
            if not self.resident:
                continue
            if not self.gpu_lock.acquire(blocking=False):
                continue
            try:
                now = time.time()
                for key in list(self.resident.keys()):
                    if now - self.last_used.get(key, now) > limit:
                        log(f"Idle for {limit // 60} min — freeing VRAM")
                        self._unload(key)
            finally:
                self.gpu_lock.release()

    # ── synthesis ──
    def _seed(self, seed: Optional[int]) -> None:
        if seed is None or self.torch is None:
            return
        self.torch.manual_seed(int(seed))
        if self.device.startswith("cuda"):
            self.torch.cuda.manual_seed_all(int(seed))

    def _clone_prompt(self, key: str, m: Any, ref_audio: str, ref_text: Optional[str], xvec: bool) -> Any:
        try:
            mtime = os.path.getmtime(ref_audio)
        except OSError:
            mtime = 0
        ck = (key, ref_audio, mtime, ref_text or "", xvec)
        if ck in self.prompt_cache:
            self.prompt_cache.move_to_end(ck)
            return self.prompt_cache[ck]
        prompt = m.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text if not xvec else None, x_vector_only_mode=xvec)
        self.prompt_cache[ck] = prompt
        while len(self.prompt_cache) > 24:
            self.prompt_cache.popitem(last=False)
        return prompt

    def synthesize(self, req: Dict[str, Any]) -> Tuple[Any, int, Dict[str, str]]:
        import numpy as np

        text = str(req.get("text") or "").strip()
        if not text:
            raise BadRequest("text is empty")
        language = normalize_language(req.get("language"))
        ref_audio = req.get("ref_audio")
        if not ref_audio and req.get("ref_audio_b64"):
            ref_audio = save_temp_audio(str(req["ref_audio_b64"]), str(req.get("ref_audio_ext") or ".wav"))
        ref_text = (req.get("ref_text") or "").strip() or None
        design = (req.get("design") or "").strip()
        instruct = (req.get("instruct") or "").strip() or None
        speaker = req.get("speaker")
        xvec = False
        size = "0.6b" if str(req.get("size") or self.args.clone_size).lower().startswith("0.6") else "1.7b"
        info: Dict[str, str] = {}

        if ref_audio:
            ref_audio = str(ref_audio)
            if not os.path.isfile(ref_audio):
                raise BadRequest(f"Reference audio not found: {ref_audio}")
            xvec = bool(req.get("x_vector_only")) or not ref_text
            mode, key = "clone", f"base-{size}"
            info["mode"] = "clone-xvector" if xvec else "clone"
            if instruct:
                info["note"] = "Delivery instructions are not supported when cloning; the reference sample sets the style."
        elif design:
            mode, key = "design", "design-1.7b"
            info["mode"] = "design"
        else:
            mode, key = "custom", f"custom-{size}"
            speaker = resolve_speaker(speaker, language)
            info["mode"] = "speaker"
            info["speaker"] = speaker

        chunks = split_text(text, int(req.get("max_chars") or 260))
        gen_kwargs: Dict[str, Any] = {}
        for k in ("temperature", "top_p", "top_k", "repetition_penalty"):
            if req.get(k) is not None:
                gen_kwargs[k] = req[k]

        with self.gpu_lock:
            try:
                m = self.model(key)
            except Exception:
                self.set_state("idle")
                raise
            self.set_state("generating", f"{len(chunks)} part{'s' if len(chunks) != 1 else ''}")
            t0 = time.time()
            try:
                self._seed(req.get("seed"))
                prompt = self._clone_prompt(key, m, ref_audio, ref_text, xvec) if mode == "clone" else None
                pieces: List[Any] = []
                sr = 24000
                for i, (chunk, pause) in enumerate(chunks):
                    if len(chunks) > 1:
                        log(f"Generating part {i + 1}/{len(chunks)} ({len(chunk)} chars)")
                    if mode == "clone":
                        wavs, sr = m.generate_voice_clone(text=chunk, language=language, voice_clone_prompt=prompt, **gen_kwargs)
                    elif mode == "design":
                        desc = design if not instruct else f"{design}. Delivery: {instruct}"
                        wavs, sr = m.generate_voice_design(text=chunk, instruct=desc, language=language, **gen_kwargs)
                    else:
                        wavs, sr = m.generate_custom_voice(text=chunk, speaker=speaker, language=language, instruct=instruct, **gen_kwargs)
                    wav = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
                    pieces.append(wav)
                    if pause > 0:
                        pieces.append(np.zeros(int(sr * pause), dtype=np.float32))
                audio = normalize(np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32))
                self.last_used[key] = time.time()
                dur = audio.size / float(sr)
                took = time.time() - t0
                log(f"Done: {dur:.1f}s of audio in {took:.1f}s ({MODELS[key]['label']})")
                info["model"] = MODELS[key]["repo"]
                info["duration"] = f"{dur:.3f}"
                return audio, sr, info
            finally:
                self.set_state("idle")

    def health(self) -> Dict[str, Any]:
        with self.meta_lock:
            st, detail = self.state, self.detail
        vram_free = None
        if self.torch is not None and self.device.startswith("cuda"):
            try:
                free, _total = self.torch.cuda.mem_get_info()
                vram_free = int(free)
            except Exception:
                vram_free = None
        return {
            "ok": True,
            "version": VERSION,
            "device": self.device,
            "device_name": self.device_name,
            "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
            "torch": getattr(self.torch, "__version__", None),
            "vram_total": self.vram_total,
            "vram_free": vram_free,
            "loaded": list(self.resident.keys()),
            "state": st,
            "detail": detail,
            "models": {k: {"repo": v["repo"], "label": v["label"], "downloaded": bool(cached_snapshot(v["repo"]))} for k, v in MODELS.items()},
        }


class BadRequest(Exception):
    pass


def normalize_language(lang: Any) -> str:
    if not lang:
        return "Auto"
    s = str(lang).strip()
    low = s.lower()
    codes = {
        "en": "English", "zh": "Chinese", "cn": "Chinese", "ja": "Japanese", "jp": "Japanese", "ko": "Korean",
        "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
    }
    base = re.split(r"[-_]", low)[0]
    if base in codes:
        return codes[base]
    for name in LANGUAGES:
        if name.lower() == low:
            return name
    return "Auto"


def resolve_speaker(speaker: Any, language: str) -> str:
    if speaker:
        s = str(speaker).strip()
        for sp in SPEAKERS:
            if sp["id"].lower() == s.lower():
                return sp["id"]
        mapped = OPENAI_VOICE_MAP.get(s.lower())
        if mapped:
            return mapped
        raise BadRequest(f"Unknown speaker '{s}'. Available: {', '.join(sp['id'] for sp in SPEAKERS)}")
    return DEFAULT_SPEAKER.get(language, "Ryan")


# ─── Hugging Face cache ──────────────────────────────────────────────────────


def cached_snapshot(repo: str) -> Optional[str]:
    """Local snapshot folder if the model weights are fully present, else None."""
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    base = os.path.join(home, "hub", "models--" + repo.replace("/", "--"), "snapshots")
    if not os.path.isdir(base):
        return None
    for snap in sorted(os.listdir(base), key=lambda s: os.path.getmtime(os.path.join(base, s)), reverse=True):
        d = os.path.join(base, snap)
        try:
            files = os.listdir(d)
        except OSError:
            continue
        if "config.json" in files and "speech_tokenizer" in files and any(f.endswith(".safetensors") for f in files):
            return d
    return None


def download(repo: str) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=repo)


# ─── HTTP ────────────────────────────────────────────────────────────────────

ENGINE: Optional[Engine] = None
SERVER: Optional[ThreadingHTTPServer] = None


class Handler(BaseHTTPRequestHandler):
    server_version = f"StitchVoice/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # keep stdout for progress lines
        return

    # ── helpers ──
    def _send(self, status: int, body: bytes, ctype: str, headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj: Any) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

    def _body(self) -> Dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16 * 1024 * 1024:
            raise BadRequest("request too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as err:
            raise BadRequest(f"invalid JSON: {err}")
        if not isinstance(data, dict):
            raise BadRequest("expected a JSON object")
        return data

    def _audio(self, audio: Any, sr: int, info: Dict[str, str], fmt: str = "wav") -> None:
        headers = {"X-Sample-Rate": str(sr)}
        for k, v in info.items():
            headers[f"X-Stitch-{k.capitalize()}"] = re.sub(r"[\r\n]", " ", str(v))
        if fmt == "pcm":
            self._send(200, pcm_bytes(audio), "audio/pcm", headers)
        elif fmt == "flac":
            import soundfile as sf

            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="FLAC")
            self._send(200, buf.getvalue(), "audio/flac", headers)
        else:
            self._send(200, wav_bytes(audio, sr), "audio/wav", headers)

    def _guard(self, fn) -> None:  # type: ignore[no-untyped-def]
        try:
            fn()
        except BadRequest as err:
            self._json(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            sys.stdout.flush()
            msg = str(err) or err.__class__.__name__
            if "out of memory" in msg.lower():
                msg = "The GPU ran out of memory. Close other GPU apps or pick another GPU for voice in Settings."
            self._json(500, {"error": msg})

    # ── routes ──
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/") or "/"
        assert ENGINE is not None
        if path in ("/", "/health"):
            self._guard(lambda: self._json(200, ENGINE.health()))
        elif path == "/speakers":
            self._json(200, {"speakers": SPEAKERS})
        elif path == "/languages":
            self._json(200, {"languages": LANGUAGES})
        elif path == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": "qwen3-tts", "object": "model", "owned_by": "qwen"}]})
        else:
            self._json(404, {"error": f"no route {path}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0].rstrip("/")
        assert ENGINE is not None
        engine = ENGINE

        def tts() -> None:
            audio, sr, info = engine.synthesize(self._body())
            self._audio(audio, sr, info)

        def design() -> None:
            body = self._body()
            if not (body.get("instruct") or body.get("design")):
                raise BadRequest("describe the voice in 'instruct'")
            body["design"] = body.get("design") or body.get("instruct")
            body["instruct"] = None
            body.pop("ref_audio", None)
            audio, sr, info = engine.synthesize(body)
            self._audio(audio, sr, info)

        def openai_speech() -> None:
            body = self._body()
            voice = str(body.get("voice") or "")
            req: Dict[str, Any] = {"text": body.get("input"), "language": body.get("language"), "instruct": body.get("instructions")}
            if voice.lower().startswith("design:"):
                req["design"] = voice.split(":", 1)[1]
            elif voice and os.path.isfile(voice) and os.path.splitext(voice)[1].lower() in AUDIO_EXTS:
                req["ref_audio"] = voice
                req["ref_text"] = body.get("ref_text")
            else:
                req["speaker"] = voice or None
            audio, sr, info = engine.synthesize(req)
            fmt = str(body.get("response_format") or "wav").lower()
            self._audio(audio, sr, info, fmt if fmt in ("wav", "pcm", "flac") else "wav")

        def dl() -> None:
            key = str(self._body().get("model") or "")
            if key not in MODELS:
                raise BadRequest(f"unknown model '{key}'. Known: {', '.join(MODELS)}")
            try:
                path_ = engine.ensure_downloaded(key)
            finally:
                engine.set_state("idle")
            self._json(200, {"ok": True, "path": path_})

        def unload() -> None:
            engine.unload_all()
            self._json(200, {"ok": True})

        def shutdown() -> None:
            self._json(200, {"ok": True})
            log("Shutting down")
            threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0)), daemon=True).start()

        routes = {
            "/tts": tts,
            "/design": design,
            "/v1/audio/speech": openai_speech,
            "/audio/speech": openai_speech,
            "/download": dl,
            "/unload": unload,
            "/shutdown": shutdown,
        }
        fn = routes.get(path)
        if not fn:
            self._json(404, {"error": f"no route {path}"})
            return
        self._guard(fn)


# ─── CLI ─────────────────────────────────────────────────────────────────────


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Stitch Voice — local Qwen3-TTS server (voice cloning, preset speakers, voice design).")
    p.add_argument("--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=7862, help="port (default 7862)")
    p.add_argument("--device", default="auto", help="torch device, e.g. cuda:0 or cpu (default: cuda:0 when available)")
    p.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"], help="weights dtype on GPU")
    p.add_argument("--no-flash-attn", action="store_true", help="never use FlashAttention 2 even if installed")
    p.add_argument("--clone-size", default="1.7B", choices=["1.7B", "0.6B"], help="default Base/CustomVoice model size")
    p.add_argument("--max-resident", type=int, default=2, help="models kept in VRAM at once (default 2)")
    p.add_argument("--idle-unload", type=int, default=600, help="seconds of inactivity before models are unloaded (0 = never)")
    p.add_argument("--download", metavar="MODEL", choices=list(MODELS.keys()) + ["all"], help="download a model into HF_HOME and exit")
    p.add_argument("--version", action="version", version=VERSION)
    return p.parse_args(argv)


def main() -> None:
    global ENGINE, SERVER
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)  # type: ignore[attr-defined]
        except Exception:
            pass
    args = parse_args()

    if args.download:
        keys = list(MODELS.keys()) if args.download == "all" else [args.download]
        for key in keys:
            repo = MODELS[key]["repo"]
            if cached_snapshot(repo):
                log(f"{repo} is already downloaded")
                continue
            state("downloading", key)
            log(f"Downloading {repo}…")
            download(repo)
            log(f"Downloaded {repo}")
        state("idle")
        return

    ENGINE = Engine(args)
    ENGINE.boot()
    threading.Thread(target=ENGINE.idle_sweeper, daemon=True).start()
    SERVER = ThreadingHTTPServer((args.host, args.port), Handler)
    SERVER.daemon_threads = True
    log(f"Stitch Voice {VERSION} listening on http://{args.host}:{args.port}")
    state("idle")
    try:
        SERVER.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
