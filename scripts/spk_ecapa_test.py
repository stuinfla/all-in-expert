#!/usr/bin/env python3
"""
Is the speaker encoder the bottleneck? Head-to-head, with free ground truth.

THE TEST
  Jason opens every episode ("welcome to episode N of the all-in podcast"), so
  the 12-40s window is him, in every episode, for free. Cluster each episode's
  windows, take the cluster that owns the intro -> that centroid IS Jason.

  Then ask: is Jason(episode A) nearest to Jason(episode B), or to one of B's
  other three voices? Chance = 25%. This needs no labels and no money, and it
  measures the one thing everything else depends on: can we recognise the same
  person across episodes?

RESULT WITH resemblyzer (measured 2026-07-10):
  Jason~Jason 0.814 vs Jason~others 0.790, margin +0.025, correct 37%.
  i.e. barely above chance. Every naming scheme built on it inherited the noise.

This script runs the identical test with SpeechBrain ECAPA-TDNN (192-dim,
~1% EER vs resemblyzer's ~5%). Free, local, Apple-GPU.

Usage: python3 scripts/spk_ecapa_test.py [n_episodes]
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import warnings
from collections import Counter
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from sklearn.cluster import KMeans  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AUDIO, CAPS, EMB = ROOT / "data" / "audio", ROOT / "data" / "captions", ROOT / "data" / "speaker"
SR, WIN, HOP, K = 16_000, 3.0, 1.5, 4
BATCH = 64

AUDIO.mkdir(parents=True, exist_ok=True)


def dev() -> str:
    return "mps" if torch.backends.mps.is_available() else "cpu"


def encoder():
    """
    speechbrain 1.1.0 + torch 2.11 crashes on run_opts={'device': ...}
    ("'EncoderClassifier' object has no attribute 'device_type'"). Build on the
    default device, then move the modules ourselves. Falls back to CPU if the
    Metal backend rejects an op.
    """
    from speechbrain.inference.speaker import EncoderClassifier

    enc = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(ROOT / "data" / "speaker" / "ecapa"),
    )
    if dev() == "mps":
        try:
            enc.mods.to("mps")
            with torch.no_grad():
                enc.encode_batch(torch.randn(2, SR, device="mps"))
        except Exception:
            enc.mods.to("cpu")
            globals()["_FORCE_CPU"] = True
    return enc


_FORCE_CPU = False


def run_dev() -> str:
    return "cpu" if _FORCE_CPU else dev()


def minutes(vid: str) -> float:
    j = json.loads((CAPS / f"{vid}.en.json3").read_text())
    end = max((e["tStartMs"] + e.get("dDurationMs", 0)) for e in j.get("events", []) if e.get("segs"))
    return end / 60000.0


def fetch(vid: str) -> Path:
    wav = AUDIO / f"{vid}.wav"
    if wav.exists():
        return wav
    raw = AUDIO / f"{vid}.src"
    subprocess.run(["yt-dlp", "-f", "bestaudio", "-N", "8", "--no-progress", "-q",
                    "--no-warnings", "-o", str(raw), f"https://youtu.be/{vid}"], check=True, timeout=600)
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw),
                    "-ac", "1", "-ar", str(SR), "-f", "wav", str(wav)], check=True, timeout=600)
    raw.unlink(missing_ok=True)
    return wav


def embed(enc, vid: str):
    npz = EMB / f"ecapa-{vid}.npz"
    if npz.exists():
        z = np.load(npz)
        return z["V"], z["T"]
    wav, _ = sf.read(str(fetch(vid)), dtype="float32")
    n = int(WIN * SR)
    segs, times = [], []
    t = 0.0
    while (t + WIN) * SR <= len(wav):
        s = wav[int(t * SR): int(t * SR) + n]
        if float(np.sqrt(np.mean(s ** 2))) > 0.005:      # skip silence
            segs.append(s)
            times.append(t)
        t += HOP
    out = []
    for i in range(0, len(segs), BATCH):
        b = torch.tensor(np.stack(segs[i:i + BATCH]), device=run_dev())
        with torch.no_grad():
            e = enc.encode_batch(b).squeeze(1).cpu().numpy()
        out.append(e)
    V = np.concatenate(out).astype(np.float32)
    V /= np.linalg.norm(V, axis=1, keepdims=True)
    T = np.array(times, np.float32)
    np.savez_compressed(npz, V=V, T=T)
    (AUDIO / f"{vid}.wav").unlink(missing_ok=True)        # 140 MB each
    return V, T


def main(n_eps: int) -> None:
    vids = [p.name.split(".en.json3")[0] for p in sorted(CAPS.glob("*.en.json3"))]
    vids = [v for v in vids if (EMB / f"emb-{v}.npz").exists()][:n_eps]   # reuse the same episodes
    enc = encoder()
    print(f"  ECAPA on {run_dev()}  |  episodes: {len(vids)}", flush=True)

    jas, oth = [], []
    t0 = time.time()
    for i, v in enumerate(vids, 1):
        try:
            V, T = embed(enc, v)
        except Exception as e:
            print(f"  {v} FAILED {str(e)[:60]}", flush=True)
            continue
        if len(V) < 200:
            continue
        lab = KMeans(K, n_init=10, random_state=0).fit_predict(V)
        cent = np.stack([V[lab == k].mean(0) for k in range(K)])
        cent /= np.linalg.norm(cent, axis=1, keepdims=True)
        sel = [l for t, l in zip(T, lab) if 12 <= t <= 40]
        if not sel:
            continue
        top, c = Counter(sel).most_common(1)[0]
        jas.append((cent[top], c / len(sel)))
        oth.append(np.delete(cent, top, axis=0))
        print(f"  [{i}/{len(vids)}] {v}  intro purity {c/len(sel):.2f}  ({time.time()-t0:.0f}s)", flush=True)

    print(f"\n  episodes usable: {len(jas)}")
    print(f"  mean intro-cluster purity: {np.mean([p for _, p in jas]):.2f}")
    jj, jo, wins, tot = [], [], 0, 0
    for i in range(len(jas)):
        for j in range(i + 1, len(jas)):
            s = float(jas[i][0] @ jas[j][0])
            o = [float(jas[i][0] @ x) for x in oth[j]]
            jj.append(s)
            jo.extend(o)
            wins += s > max(o)
            tot += 1
    print(f"  Jason(A)~Jason(B)  = {np.mean(jj):.3f}")
    print(f"  Jason(A)~others(B) = {np.mean(jo):.3f}")
    print(f"  margin             = {np.mean(jj)-np.mean(jo):+.3f}   (resemblyzer: +0.025)")
    print(f"  nearest correct    = {wins}/{tot} = {100*wins/max(tot,1):.0f}%   (resemblyzer: 37%, chance 25%)")
    print("\n  VERDICT:", "ECAPA FIXES cross-episode identity" if wins / max(tot, 1) > 0.85
          else "still unreliable — diarization needs a stronger pipeline")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8)
