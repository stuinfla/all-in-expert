#!/usr/bin/env python3
"""
Batch: download episode audio, embed 3s windows, cache, delete the wav.

Everything local, $0. Measured on this machine (2026-07-10):
  yt-dlp plain download   2.3 MB/s   (the old "40 KB/s throttle" was an artifact
                                      of --download-sections pacing via ffmpeg)
  resemblyzer on MPS      ~45 ms per 3s window
  => ~1 min of GPU per hour of podcast, ~30s to fetch it.

Audio is deleted after embedding: a 72-min wav is ~140 MB, the embeddings are
~3 MB. Only the .npz is kept.

Usage: python3 scripts/spk_embed_batch.py [count]
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from resemblyzer import VoiceEncoder, preprocess_wav  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "data" / "audio"
CAPS = ROOT / "data" / "captions"
OUT = ROOT / "data" / "speaker"
SR, WIN_S, HOP_S = 16_000, 3.0, 1.5
MIN_MINUTES = 40          # full episodes only; clips are roundtable excerpts

AUDIO.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)


def caption_minutes(vid: str) -> float:
    try:
        j = json.loads((CAPS / f"{vid}.en.json3").read_text())
    except Exception:
        return 0.0
    end = 0
    for e in j.get("events", []):
        if e.get("segs"):
            end = max(end, e["tStartMs"] + e.get("dDurationMs", 0))
    return end / 60000.0


def full_episodes() -> list[str]:
    vids = sorted(p.name.split(".en.json3")[0] for p in CAPS.glob("*.en.json3"))
    return [v for v in vids if caption_minutes(v) >= MIN_MINUTES]


def embed_episode(enc: VoiceEncoder, vid: str) -> bool:
    npz = OUT / f"emb-{vid}.npz"
    if npz.exists():
        return True
    raw, wavp = AUDIO / f"{vid}.src", AUDIO / f"{vid}.wav"
    try:
        if not wavp.exists():
            subprocess.run(["yt-dlp", "-f", "bestaudio", "-N", "8", "--no-progress",
                            "-q", "--no-warnings", "-o", str(raw),
                            f"https://youtu.be/{vid}"], check=True, timeout=600)
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i",
                            str(raw), "-ac", "1", "-ar", str(SR), "-f", "wav",
                            str(wavp)], check=True, timeout=600)
            raw.unlink(missing_ok=True)

        wav, _ = sf.read(str(wavp), dtype="float32")
        wav = preprocess_wav(wav, source_sr=SR)      # volume-normalise + trim silence
        dur = len(wav) / SR
        V, T = [], []
        t = 0.0
        while t + WIN_S <= dur:
            a = int(t * SR)
            s = wav[a:a + int(WIN_S * SR)]
            if float(np.sqrt(np.mean(s ** 2))) > 0.005:   # skip silence
                V.append(enc.embed_utterance(s))
                T.append(t)
            t += HOP_S
        if not V:
            return False
        M = np.stack(V)
        M /= np.linalg.norm(M, axis=1, keepdims=True)
        np.savez_compressed(npz, V=M.astype(np.float32), T=np.array(T, np.float32))
        return True
    finally:
        raw.unlink(missing_ok=True)
        wavp.unlink(missing_ok=True)                  # 140 MB each — do not hoard


def main(limit: int) -> None:
    enc = VoiceEncoder("mps")
    eps = full_episodes()
    todo = [v for v in eps if not (OUT / f"emb-{v}.npz").exists()][:limit]
    print(f"  full episodes with captions: {len(eps)}   to embed now: {len(todo)}", flush=True)
    t0 = time.time()
    for i, vid in enumerate(todo, 1):
        try:
            ok = embed_episode(enc, vid)
            el = time.time() - t0
            print(f"  [{i}/{len(todo)}] {vid} {'ok' if ok else 'EMPTY'}  "
                  f"({el/60:.1f} min elapsed, ~{el/i*(len(todo)-i)/60:.0f} min left)", flush=True)
        except Exception as e:  # a private/deleted video must not kill the batch
            print(f"  [{i}/{len(todo)}] {vid} FAILED: {str(e)[:70]}", flush=True)
    print(f"  done in {(time.time()-t0)/60:.1f} min", flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 30)
