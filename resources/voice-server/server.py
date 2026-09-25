#!/usr/bin/env python3
"""
Stitch Voice — a small local HTTP server around three local TTS engines:

  qwen3   Qwen3-TTS (Apache-2.0)          voice cloning, preset speakers, voice design · GPU
  kokoro  Kokoro-82M (Apache-2.0)         54 preset voices in 9 languages · GPU (CPU fallback)
  pocket  Kyutai Pocket TTS (MIT code, CC-BY-4.0 weights)  preset voices + cloning · CPU

Each engine's Python package is installed on demand by Stitch; an engine whose
package is missing simply answers with an error.

    python server.py --port 7862                 # serve
    python server.py --download base-1.7b        # fetch a model into HF_HOME and exit

JSON in, WAV bytes out. Everything binds to 127.0.0.1 by default.

  GET  /health             device, loaded models, state, which models are on disk, which engines are importable
  GET  /speakers           CustomVoice preset speakers
  GET  /languages          supported languages
  POST /tts                {engine?: "qwen3"|"kokoro"|"pocket", text, ...}
                           qwen3:  {language, ref_audio, ref_text, x_vector_only, speaker, instruct, design, size, seed}
                                   ref_audio → voice clone (Base), design → VoiceDesign, else CustomVoice speaker
                           kokoro: {voice: "af_heart" | "af_heart,af_bella" (blend), speed, lang?}
                           pocket: {voice: preset name | ref_audio (clone), language: "english"…, hf_token?, temperature?}
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

VERSION = "1.1.0"

KOKORO_REPO = "hexgrad/Kokoro-82M"
POCKET_REPO = "kyutai/pocket-tts"  # gated (accept terms on HF) — includes the voice-cloning encoder
POCKET_OPEN_REPO = "kyutai/pocket-tts-without-voice-cloning"
POCKET_LANGUAGES = ["english", "french", "german", "portuguese", "italian", "spanish", "dutch"]

MODELS: Dict[str, Dict[str, str]] = {
    "base-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "type": "base", "label": "Voice clone 1.7B", "engine": "qwen3"},
    "base-0.6b": {"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "type": "base", "label": "Voice clone 0.6B", "engine": "qwen3"},
    "custom-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "type": "custom", "label": "Preset speakers 1.7B", "engine": "qwen3"},
    "custom-0.6b": {"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "type": "custom", "label": "Preset speakers 0.6B", "engine": "qwen3"},
    "design-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "type": "design", "label": "Voice design 1.7B", "engine": "qwen3"},
    "kokoro-82m": {"repo": KOKORO_REPO, "type": "kokoro", "label": "Kokoro 82M", "engine": "kokoro"},
}
for _lang in POCKET_LANGUAGES:
    MODELS[f"pocket-{_lang}"] = {"repo": POCKET_OPEN_REPO, "type": "pocket", "label": f"Pocket TTS · {_lang.capitalize()}", "engine": "pocket", "language": _lang}

ENGINE_MODULES = {"qwen3": "qwen_tts", "kokoro": "kokoro", "pocket": "pocket_tts"}

# Kokoro language codes (first letter of every voice id).
KOKORO_LANGS = {
    "a": "American English", "b": "British English", "e": "Spanish", "f": "French", "h": "Hindi",
    "i": "Italian", "j": "Japanese", "p": "Brazilian Portuguese", "z": "Mandarin Chinese",
}
KOKORO_DEFAULT_VOICE = {"a": "af_heart", "b": "bf_emma", "e": "ef_dora", "f": "ff_siwis", "h": "hf_alpha", "i": "if_sara", "j": "jf_alpha", "p": "pf_dora", "z": "zf_xiaoxiao"}
POCKET_DEFAULT_VOICE = {"english": "alba", "french": "estelle", "german": "juergen", "portuguese": "rafael", "italian": "giovanni", "spanish": "lola", "dutch": "daan"}
POCKET_CLONING_HELP = (
    "Voice cloning with Pocket TTS needs Kyutai's gated weights: accept the terms at "
    "https://huggingface.co/kyutai/pocket-tts, then add a Hugging Face read token to the Pocket TTS voice engine."
)

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
        self.gpu_lock = threading.Lock()  # one GPU job at a time (Qwen3-TTS, Kokoro)
        self.cpu_lock = threading.Lock()  # Pocket TTS runs on the CPU, next to GPU work
        self.meta_lock = threading.Lock()  # protects the fields below
        self.resident: "OrderedDict[str, Any]" = OrderedDict()
        # Kokoro: one KModel shared by per-language pipelines.
        self.kokoro: Optional[Dict[str, Any]] = None
        # Pocket TTS: one model per language (a couple at most) + cached voice states.
        self.pocket: "OrderedDict[str, Any]" = OrderedDict()
        self.pocket_states: "OrderedDict[Tuple, Any]" = OrderedDict()
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

    def _unload_kokoro(self) -> None:
        if self.kokoro is None:
            return
        self.kokoro = None
        self.last_used.pop("kokoro-82m", None)
        gc.collect()
        if self.torch is not None and self.device.startswith("cuda"):
            self.torch.cuda.empty_cache()
        log("Unloaded Kokoro 82M")

    def _unload_pocket(self, lang: Optional[str] = None) -> None:
        for key in [lang] if lang else list(self.pocket.keys()):
            if self.pocket.pop(key, None) is not None:
                self.last_used.pop(f"pocket-{key}", None)
                for k in [k for k in self.pocket_states if k[0] == key]:
                    self.pocket_states.pop(k, None)
                log(f"Unloaded Pocket TTS · {key}")
        gc.collect()

    def unload_all(self) -> None:
        with self.gpu_lock:
            for key in list(self.resident.keys()):
                self._unload(key)
            self._unload_kokoro()
            self.set_state("idle")
        with self.cpu_lock:
            self._unload_pocket()

    def ensure_downloaded(self, key: str) -> str:
        path = model_ready(key)
        if path:
            return path
        repo = MODELS[key]["repo"]
        self.set_state("downloading", key)
        log(f"Downloading {MODELS[key]['label']} ({repo}) — first use only…")
        path = download(key)
        log(f"Downloaded {MODELS[key]['label']}")
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
            now = time.time()
            if (self.resident or self.kokoro is not None) and self.gpu_lock.acquire(blocking=False):
                try:
                    for key in list(self.resident.keys()):
                        if now - self.last_used.get(key, now) > limit:
                            log(f"Idle for {limit // 60} min — freeing VRAM")
                            self._unload(key)
                    if self.kokoro is not None and now - self.last_used.get("kokoro-82m", now) > limit:
                        self._unload_kokoro()
                finally:
                    self.gpu_lock.release()
            if self.pocket and self.cpu_lock.acquire(blocking=False):
                try:
                    for lang in list(self.pocket.keys()):
                        if now - self.last_used.get(f"pocket-{lang}", now) > limit:
                            self._unload_pocket(lang)
                finally:
                    self.cpu_lock.release()

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
        engine = str(req.get("engine") or "qwen3").lower()
        if engine not in ENGINE_MODULES:
            raise BadRequest(f"unknown engine '{engine}'. Known: {', '.join(ENGINE_MODULES)}")
        if not engine_available(engine):
            raise BadRequest(f"The {ENGINE_NAMES[engine]} engine is not installed — install it in Stitch (Generate → Voice).")
        if engine == "kokoro":
            return self.synthesize_kokoro(req)
        if engine == "pocket":
            return self.synthesize_pocket(req)
        return self.synthesize_qwen(req)

    # ── Kokoro ──
    def _kokoro(self) -> Dict[str, Any]:
        """Loaded Kokoro model (+ pipelines); caller holds gpu_lock."""
        if self.kokoro is not None:
            self.last_used["kokoro-82m"] = time.time()
            return self.kokoro
        path = self.ensure_downloaded("kokoro-82m")
        self.set_state("loading-model", "kokoro-82m")
        dev = self.device if self.device.startswith("cuda") else "cpu"
        log(f"Loading Kokoro 82M onto {dev}…")
        t0 = time.time()
        from kokoro import KModel

        cfg, weights = os.path.join(path, "config.json"), os.path.join(path, "kokoro-v1_0.pth")
        try:
            m = KModel(repo_id=KOKORO_REPO, config=cfg, model=weights).to(dev).eval()
        except Exception as err:
            if dev == "cpu" or "out of memory" not in str(err).lower():
                raise
            log("Out of VRAM — running Kokoro on the CPU instead")
            dev = "cpu"
            m = KModel(repo_id=KOKORO_REPO, config=cfg, model=weights).to(dev).eval()
        self.kokoro = {"model": m, "path": path, "device": dev, "pipes": {}, "voices": {}}
        self.last_used["kokoro-82m"] = time.time()
        log(f"Loaded Kokoro 82M in {time.time() - t0:.1f}s")
        return self.kokoro

    def _kokoro_voice(self, k: Dict[str, Any], voice: str) -> Any:
        """Voice pack tensor; 'a,b' blends voices by averaging (Kokoro's own convention)."""
        if voice in k["voices"]:
            return k["voices"][voice]
        torch = self.torch
        packs = []
        for name in [v.strip() for v in voice.split(",") if v.strip()]:
            if not re.fullmatch(r"[a-z]{2}_[a-z0-9_]+", name):
                raise BadRequest(f"Unknown Kokoro voice '{name}'")
            f = os.path.join(k["path"], "voices", f"{name}.pt")
            if not os.path.isfile(f):
                from huggingface_hub import hf_hub_download

                try:
                    f = hf_hub_download(repo_id=KOKORO_REPO, filename=f"voices/{name}.pt")
                except Exception:
                    raise BadRequest(f"Unknown Kokoro voice '{name}'")
            packs.append(torch.load(f, weights_only=True))
        if not packs:
            raise BadRequest("Pick a Kokoro voice")
        pack = packs[0] if len(packs) == 1 else torch.mean(torch.stack(packs), dim=0)
        k["voices"][voice] = pack
        return pack

    def synthesize_kokoro(self, req: Dict[str, Any]) -> Tuple[Any, int, Dict[str, str]]:
        import numpy as np

        text = str(req.get("text") or "").strip()
        if not text:
            raise BadRequest("text is empty")
        voice = str(req.get("voice") or "").strip().lower() or "af_heart"
        lang = str(req.get("lang") or voice[0]).lower()[:1]
        if lang not in KOKORO_LANGS:
            raise BadRequest(f"Unsupported Kokoro language '{lang}'")
        speed = min(2.0, max(0.5, float(req.get("speed") or 1.0)))
        chunks = split_text(text, int(req.get("max_chars") or 400))
        info: Dict[str, str] = {"mode": "preset", "speaker": voice, "language": KOKORO_LANGS[lang]}
        with self.gpu_lock:
            try:
                k = self._kokoro()
                if lang not in k["pipes"]:
                    self.set_state("loading-model", "kokoro-82m")
                    from kokoro import KPipeline

                    log(f"Preparing Kokoro {KOKORO_LANGS[lang]} text frontend…")
                    k["pipes"][lang] = KPipeline(lang_code=lang, repo_id=KOKORO_REPO, model=k["model"])
                pipe = k["pipes"][lang]
                pack = self._kokoro_voice(k, voice)
            except Exception:
                self.set_state("idle")
                raise
            self.set_state("generating", f"{len(chunks)} part{'s' if len(chunks) != 1 else ''}")
            t0 = time.time()
            sr = 24000
            try:
                pieces: List[Any] = []
                for chunk, pause in chunks:
                    for result in pipe(chunk, voice=pack, speed=speed, split_pattern=None):
                        audio = result.audio
                        if audio is not None:
                            pieces.append(np.asarray(audio.detach().cpu().numpy(), dtype=np.float32).reshape(-1))
                    if pause > 0:
                        pieces.append(np.zeros(int(sr * pause), dtype=np.float32))
                if not pieces:
                    raise BadRequest("Kokoro produced no audio for this text")
                audio = normalize(np.concatenate(pieces))
                self.last_used["kokoro-82m"] = time.time()
                dur = audio.size / float(sr)
                log(f"Done: {dur:.1f}s of audio in {time.time() - t0:.1f}s (Kokoro · {voice} · {k['device']})")
                info["model"] = KOKORO_REPO
                info["duration"] = f"{dur:.3f}"
                return audio, sr, info
            finally:
                self.set_state("idle")

    # ── Pocket TTS ──
    def _pocket(self, lang: str, token: Optional[str], need_cloning: bool) -> Any:
        """Loaded Pocket TTS model for a language; caller holds cpu_lock."""
        m = self.pocket.get(lang)
        if m is not None and need_cloning and not getattr(m, "has_voice_cloning", True) and token:
            log("Reloading Pocket TTS with the voice-cloning weights")
            self._unload_pocket(lang)
            m = None
        if m is not None:
            self.pocket.move_to_end(lang)
            self.last_used[f"pocket-{lang}"] = time.time()
            return m
        while len(self.pocket) >= 2:
            self._unload_pocket(next(iter(self.pocket)))
        key = f"pocket-{lang}"
        if token:
            os.environ["HF_TOKEN"] = token
        self.set_state("loading-model" if model_ready(key) else "downloading", key)
        log(f"Loading Pocket TTS · {lang} on the CPU…")
        t0 = time.time()
        from pocket_tts import TTSModel

        m = TTSModel.load_model(language=lang)
        m.eval()
        self.pocket[lang] = m
        self.last_used[key] = time.time()
        cloning = bool(getattr(m, "has_voice_cloning", False))
        log(f"Loaded Pocket TTS · {lang} in {time.time() - t0:.1f}s ({'with' if cloning else 'without'} voice cloning)")
        return m

    def _pocket_state(self, lang: str, m: Any, voice: Optional[str], ref_audio: Optional[str]) -> Any:
        if ref_audio:
            try:
                mtime = os.path.getmtime(ref_audio)
            except OSError:
                mtime = 0
            ck: Tuple = (lang, "clone", ref_audio, mtime)
        else:
            ck = (lang, "voice", voice)
        if ck in self.pocket_states:
            self.pocket_states.move_to_end(ck)
            return self.pocket_states[ck]
        if ref_audio:
            from pathlib import Path

            if not getattr(m, "has_voice_cloning", False):
                raise BadRequest(POCKET_CLONING_HELP)
            state_ = m.get_state_for_audio_prompt(Path(ref_audio), truncate=True)
        else:
            state_ = m.get_state_for_audio_prompt(voice)
        self.pocket_states[ck] = state_
        while len(self.pocket_states) > 8:
            self.pocket_states.popitem(last=False)
        return state_

    def synthesize_pocket(self, req: Dict[str, Any]) -> Tuple[Any, int, Dict[str, str]]:
        import numpy as np

        text = str(req.get("text") or "").strip()
        if not text:
            raise BadRequest("text is empty")
        lang = pocket_language(req.get("language"))
        ref_audio = req.get("ref_audio")
        if not ref_audio and req.get("ref_audio_b64"):
            ref_audio = save_temp_audio(str(req["ref_audio_b64"]), str(req.get("ref_audio_ext") or ".wav"))
        if ref_audio and not os.path.isfile(str(ref_audio)):
            raise BadRequest(f"Reference audio not found: {ref_audio}")
        voice = str(req.get("voice") or "").strip().lower() or POCKET_DEFAULT_VOICE[lang]
        token = (req.get("hf_token") or "").strip() or None
        info: Dict[str, str] = {"mode": "clone" if ref_audio else "preset", "language": lang}
        if not ref_audio:
            info["speaker"] = voice
        chunks = split_text(text, int(req.get("max_chars") or 900))
        with self.cpu_lock:
            try:
                m = self._pocket(lang, token, bool(ref_audio))
                if not hasattr(m, "stitch_default_temp"):
                    m.stitch_default_temp = m.temp
                m.temp = float(req["temperature"]) if req.get("temperature") is not None else m.stitch_default_temp
                state_ = self._pocket_state(lang, m, voice, str(ref_audio) if ref_audio else None)
            except BadRequest:
                self.set_state("idle")
                raise
            except Exception as err:
                self.set_state("idle")
                if ref_audio and ("gated" in str(err).lower() or "401" in str(err) or "403" in str(err)):
                    raise BadRequest(POCKET_CLONING_HELP)
                raise
            self.set_state("generating", f"{len(chunks)} part{'s' if len(chunks) != 1 else ''}")
            t0 = time.time()
            sr = int(m.sample_rate)
            try:
                pieces: List[Any] = []
                for chunk, pause in chunks:
                    audio = m.generate_audio(state_, chunk)
                    pieces.append(np.asarray(audio.detach().cpu().numpy(), dtype=np.float32).reshape(-1))
                    if pause > 0:
                        pieces.append(np.zeros(int(sr * pause), dtype=np.float32))
                audio = normalize(np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32))
                self.last_used[f"pocket-{lang}"] = time.time()
                dur = audio.size / float(sr)
                log(f"Done: {dur:.1f}s of audio in {time.time() - t0:.1f}s (Pocket TTS · {lang} · {'clone' if ref_audio else voice})")
                info["model"] = f"{POCKET_REPO if getattr(m, 'has_voice_cloning', False) else POCKET_OPEN_REPO}/{lang}"
                info["duration"] = f"{dur:.3f}"
                return audio, sr, info
            finally:
                self.set_state("idle")

    # ── Qwen3-TTS ──
    def synthesize_qwen(self, req: Dict[str, Any]) -> Tuple[Any, int, Dict[str, str]]:
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
            "loaded": list(self.resident.keys()) + (["kokoro-82m"] if self.kokoro is not None else []) + [f"pocket-{k}" for k in self.pocket],
            "state": st,
            "detail": detail,
            "models": {k: {"repo": v["repo"], "label": v["label"], "engine": v["engine"], "downloaded": bool(model_ready(k))} for k, v in MODELS.items()},
            "engines": {
                e: {"available": engine_available(e), "cloning": (any(getattr(m, "has_voice_cloning", False) for m in self.pocket.values()) if self.pocket else None) if e == "pocket" else e == "qwen3"}
                for e in ENGINE_MODULES
            },
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


# ─── Engines ─────────────────────────────────────────────────────────────────

ENGINE_NAMES = {"qwen3": "Qwen3-TTS", "kokoro": "Kokoro", "pocket": "Pocket TTS"}


def engine_available(engine: str) -> bool:
    """True when the engine's Python package is importable (installed on demand by Stitch)."""
    import importlib
    import importlib.util

    mod = ENGINE_MODULES.get(engine)
    if not mod:
        return False
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def pocket_language(lang: Any) -> str:
    """Stitch/Qwen language names and ISO codes → Pocket TTS config names (default english)."""
    if not lang:
        return "english"
    low = str(lang).strip().lower()
    codes = {"en": "english", "fr": "french", "de": "german", "pt": "portuguese", "it": "italian", "es": "spanish", "nl": "dutch"}
    base = re.split(r"[-_ (]", low)[0]
    if base in codes:
        return codes[base]
    for name in POCKET_LANGUAGES:
        if low.startswith(name):
            return name
    return "english"


# ─── Hugging Face cache ──────────────────────────────────────────────────────


def hf_home() -> str:
    return os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")


def _snapshots(repo: str) -> List[str]:
    base = os.path.join(hf_home(), "hub", "models--" + repo.replace("/", "--"), "snapshots")
    if not os.path.isdir(base):
        return []
    try:
        snaps = sorted(os.listdir(base), key=lambda s: os.path.getmtime(os.path.join(base, s)), reverse=True)
    except OSError:
        return []
    return [os.path.join(base, s) for s in snaps]


def cached_snapshot(repo: str) -> Optional[str]:
    """Local snapshot folder if a Qwen3-TTS model's weights are fully present, else None."""
    for d in _snapshots(repo):
        try:
            files = os.listdir(d)
        except OSError:
            continue
        if "config.json" in files and "speech_tokenizer" in files and any(f.endswith(".safetensors") for f in files):
            return d
    return None


def pocket_ready(lang: str, cloning: bool = False) -> Optional[str]:
    """Snapshot holding Pocket TTS weights for a language (the gated cloning ones when asked)."""
    repos = [POCKET_REPO] if cloning else [POCKET_REPO, POCKET_OPEN_REPO]
    for repo in repos:
        for d in _snapshots(repo):
            if os.path.isfile(os.path.join(d, "languages", lang, "model.safetensors")):
                return d
    return None


def model_ready(key: str) -> Optional[str]:
    """Local folder with a model's weights, or None when they still need downloading."""
    m = MODELS.get(key)
    if not m:
        return None
    if m["type"] == "kokoro":
        for d in _snapshots(m["repo"]):
            if os.path.isfile(os.path.join(d, "config.json")) and os.path.isfile(os.path.join(d, "kokoro-v1_0.pth")):
                return d
        return None
    if m["type"] == "pocket":
        return pocket_ready(m["language"])
    return cached_snapshot(m["repo"])


def download(key: str) -> str:
    """Fetch a model's weights into HF_HOME (tqdm progress goes to stderr)."""
    m = MODELS[key]
    from huggingface_hub import snapshot_download

    if m["type"] == "kokoro":
        return snapshot_download(repo_id=m["repo"], allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/*.pt"])
    if m["type"] == "pocket":
        # Loading the model downloads its weights (gated cloning ones when HF_TOKEN allows it,
        # else the open ones) plus the default voice.
        from pocket_tts import TTSModel

        lang = m["language"]
        tts = TTSModel.load_model(language=lang)
        tts.get_state_for_audio_prompt(POCKET_DEFAULT_VOICE[lang])
        log(f"Pocket TTS · {lang}: voice cloning {'available' if getattr(tts, 'has_voice_cloning', False) else 'not available (gated weights not accessible)'}")
        return pocket_ready(lang) or ""
    return snapshot_download(repo_id=m["repo"])


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
            body = self._body()
            key = str(body.get("model") or "")
            if body.get("hf_token"):
                os.environ["HF_TOKEN"] = str(body["hf_token"])
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
    p = argparse.ArgumentParser(description="Stitch Voice — local TTS server (Qwen3-TTS, Kokoro, Pocket TTS).")
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
        keys = [k for k, v in MODELS.items() if v["engine"] == "qwen3"] if args.download == "all" else [args.download]
        for key in keys:
            label = MODELS[key]["label"]
            if model_ready(key):
                log(f"{label} is already downloaded")
                continue
            state("downloading", key)
            log(f"Downloading {label} ({MODELS[key]['repo']})…")
            download(key)
            log(f"Downloaded {label}")
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
