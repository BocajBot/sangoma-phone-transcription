# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper>=1.1", "numpy", "fastapi>=0.115", "uvicorn>=0.30", "python-multipart>=0.0.9"]
# ///
"""A small Whisper server for live call transcription on a LAN.

    uv run server/asr_server.py --host 0.0.0.0 --port 8790 --secret <something long>

Tuned for short utterances arriving one after another: the model stays loaded, greedy decoding
(beam 1), no carry-over between requests. Two ways in, both answering {"text": ...}:
  POST /transcribe                  WAV file as the request body   (plugin setting: "WAV file as the request body")
  POST /v1/audio/transcriptions     OpenAI style file upload       (plugin setting: "OpenAI style")
With --secret set, requests must carry it in the x-local-secret header (or as a Bearer token).
"""
import argparse
import asyncio
import hmac
import io
import time
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from faster_whisper import WhisperModel

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to serve the LAN")
p.add_argument("--port", type=int, default=8790)
p.add_argument("--model", default="large-v3-turbo", help="faster-whisper model name or path")
p.add_argument("--device", default="auto", help="cuda, cpu or auto")
p.add_argument("--compute-type", default="default", help="e.g. float16 (GPU), int8 (CPU)")
p.add_argument("--language", default="en", help="'' to detect per request")
p.add_argument("--secret", default="", help="required from clients when set")
args = p.parse_args()

model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
lock = asyncio.Lock()  # one transcription at a time on the GPU
app = FastAPI()


def check(request: Request):
    if not args.secret:
        return
    given = request.headers.get("x-local-secret", "") or request.headers.get("authorization", "").removeprefix("Bearer ")
    if not hmac.compare_digest(given, args.secret):
        raise HTTPException(401)


def decode(audio: bytes):
    """16-bit WAV (what the plugin sends) straight to samples; anything else is left to the library's decoder."""
    try:
        with wave.open(io.BytesIO(audio)) as w:
            if w.getsampwidth() != 2:
                raise wave.Error("not 16-bit")
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            if w.getnchannels() > 1:
                x = x.reshape(-1, w.getnchannels()).mean(axis=1)
            if w.getframerate() != 16000:  # the model wants 16 kHz
                n = int(len(x) * 16000 / w.getframerate())
                x = np.interp(np.linspace(0, len(x), n, endpoint=False), np.arange(len(x)), x).astype(np.float32)
            return x
    except (wave.Error, EOFError):
        return io.BytesIO(audio)


def run(audio: bytes, language: str | None):
    segments, _ = model.transcribe(decode(audio), language=language or None, beam_size=1,
                                   vad_filter=True, condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segments).strip()


async def transcribe(audio: bytes, language: str | None):
    if not audio or len(audio) > 50_000_000:
        raise HTTPException(400, "bad audio")
    async with lock:
        started = time.time()
        text = await asyncio.to_thread(run, audio, language)
    return {"text": text, "model": args.model, "seconds": round(time.time() - started, 2)}


@app.post("/transcribe")
async def raw(request: Request):
    check(request)
    return await transcribe(await request.body(), args.language)


@app.post("/v1/audio/transcriptions")
async def openai(request: Request, file: UploadFile = File(...), language: str = Form("")):
    check(request)
    return await transcribe(await file.read(), language or args.language)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": args.model}


if __name__ == "__main__":
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
