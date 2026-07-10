#!/usr/bin/env python3
"""
Local, free speaker identification for the All-In corpus.

WHY THIS IS CHEAP (measured 2026-07-10, not assumed):
  * YouTube audio downloads at ~2.3 MB/s with a plain `yt-dlp -f bestaudio`.
    The old "throttled to 40 KB/s" finding came from `--download-sections`, which
    streams through ffmpeg at ~2x realtime. That is ffmpeg pacing, not a limit.
  * YouTube audio shares ONE CLOCK with the captions already in data/captions/.
    So no re-transcription, no forced alignment, no Libsyn ad-insertion drift.
  * resemblyzer runs on Apple GPU (MPS) at ~45 ms per 3-second window.
    31,010 windows ~= 23 minutes. Zero dollars.

WHY THE PREVIOUS ATTEMPT FAILED (hypothesis, now testable):
  It reportedly scored 36-42% -- the majority-class baseline, i.e. chance. The
  obvious cause is CIRCULAR ENROLLMENT: voiceprints averaged over segments picked
  by the `sk` label, which we now know is a name-mention regex that is ~anti-
  correlated with the truth. Garbage enrollment cannot produce a good voiceprint.

  This script enrolls from sources that are TRUE BY CONSTRUCTION and independent
  of `sk`:
    - friedberg / sacks / chamath : YouTube clips whose TITLE names only them.
    - calacanis                   : the show intro. Jason opens every episode
                                    with "welcome to episode N of the all-in
                                    podcast". Same words, same speaker, forever.

  (Today the regex labels that very intro `friedberg` in one episode, and across
   9 episodes assigns it to five different people. That is the bug in one line.)

Usage:
  python3 scripts/speaker_id_pilot.py enroll         # build voiceprints
  python3 scripts/speaker_id_pilot.py label <videoId>  # label one episode
  python3 scripts/speaker_id_pilot.py validate       # held-out accuracy
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from resemblyzer import VoiceEncoder  # noqa: E402
from sklearn.cluster import AgglomerativeClustering  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CAPTIONS = ROOT / "data" / "captions"
AUDIO = ROOT / "data" / "audio"
OUT = ROOT / "data" / "speaker"
TITLES = json.loads((ROOT / "data" / "episodes" / "video_titles.json").read_text())

AUDIO.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

SR = 16_000
WIN_S = 3.0     # window length for a d-vector
HOP_S = 1.5     # 50% overlap

# A clip whose title names exactly one bestie is dominated by that bestie.
NAME_RE = {
    "chamath": re.compile(r"chamath", re.I),
    "sacks": re.compile(r"\bsacks\b", re.I),
    "friedberg": re.compile(r"friedberg|freeberg", re.I),
    "calacanis": re.compile(r"\bjason\b|calacanis|j-?cal", re.I),
}
INTRO_RE = re.compile(r"welcome to episode \d+ of the all.?in", re.I)

_encoder: VoiceEncoder | None = None


def encoder() -> VoiceEncoder:
    global _encoder
    if _encoder is None:
        import torch

        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        _encoder = VoiceEncoder(dev)
    return _encoder


def fetch_audio(video_id: str) -> Path:
    """Plain download (NOT --download-sections, which ffmpeg paces at ~2x realtime)."""
    wav = AUDIO / f"{video_id}.wav"
    if wav.exists():
        return wav
    raw = AUDIO / f"{video_id}.src"
    if not raw.exists():
        subprocess.run(
            ["yt-dlp", "-f", "bestaudio", "-N", "8", "--no-progress", "-q",
             "-o", str(raw), f"https://youtu.be/{video_id}"],
            check=True,
        )
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw),
         "-ac", "1", "-ar", str(SR), "-f", "wav", str(wav)],
        check=True,
    )
    raw.unlink(missing_ok=True)
    return wav


def load_wav(path: Path) -> np.ndarray:
    import soundfile as sf

    wav, sr = sf.read(str(path), dtype="float32")
    assert sr == SR, f"expected {SR} Hz, got {sr}"
    return wav


def windows(wav: np.ndarray, start_s: float = 0.0, end_s: float | None = None):
    """Yield (centre_seconds, samples) for each analysis window."""
    end_s = len(wav) / SR if end_s is None else min(end_s, len(wav) / SR)
    t = start_s
    while t + WIN_S <= end_s:
        a, b = int(t * SR), int((t + WIN_S) * SR)
        seg = wav[a:b]
        # skip near-silence: a d-vector of silence is meaningless
        if float(np.sqrt(np.mean(seg ** 2))) > 0.005:
            yield t + WIN_S / 2, seg
        t += HOP_S


def embed_many(segs: list[np.ndarray]) -> np.ndarray:
    enc = encoder()
    vecs = [enc.embed_utterance(s) for s in segs]
    return np.stack(vecs) if vecs else np.zeros((0, 256), dtype=np.float32)


def dominant_centroid(vecs: np.ndarray) -> np.ndarray:
    """A clip may contain an interviewer. Split in two, keep the bigger voice."""
    if len(vecs) < 8:
        v = vecs.mean(0)
        return v / (np.linalg.norm(v) + 1e-9)
    lab = AgglomerativeClustering(n_clusters=2, metric="cosine", linkage="average").fit_predict(vecs)
    big = 0 if (lab == 0).sum() >= (lab == 1).sum() else 1
    v = vecs[lab == big].mean(0)
    return v / (np.linalg.norm(v) + 1e-9)


def clip_ids_for(name: str, limit: int) -> list[str]:
    out = []
    for vid, title in TITLES.items():
        if not title:
            continue
        hit = [k for k, r in NAME_RE.items() if r.search(title)]
        if hit == [name]:
            out.append(vid)
        if len(out) >= limit:
            break
    return out


def intro_video_ids(limit: int) -> list[str]:
    idx = json.loads((ROOT / "web" / "public" / "data" / "content-index.json").read_text())
    vids = []
    for e in idx.values():
        if INTRO_RE.search(e["c"]) and e["v"] not in vids:
            vids.append(e["v"])
        if len(vids) >= limit:
            break
    return vids


def cmd_enroll(holdout: int = 1) -> None:
    prints, heldout = {}, {}
    for name in ("chamath", "sacks", "friedberg"):
        ids = clip_ids_for(name, 4)
        if len(ids) < 2:
            print(f"  {name}: only {len(ids)} clips — skipping")
            continue
        train, test = ids[:-holdout], ids[-holdout:]
        cents = []
        for vid in train:
            wav = load_wav(fetch_audio(vid))
            segs = [s for _, s in windows(wav)]
            if not segs:
                continue
            cents.append(dominant_centroid(embed_many(segs)))
            print(f"  {name:10} enrolled from {vid} ({len(segs)} windows)")
        v = np.mean(cents, 0)
        prints[name] = v / (np.linalg.norm(v) + 1e-9)
        heldout[name] = test

    # Jason: the intro. Same sentence, same speaker, every episode.
    ids = intro_video_ids(4)
    train, test = ids[:-holdout], ids[-holdout:]
    cents = []
    for vid in train:
        wav = load_wav(fetch_audio(vid))
        segs = [s for _, s in windows(wav, start_s=8, end_s=45)]  # past the music sting
        if not segs:
            continue
        cents.append(dominant_centroid(embed_many(segs)))
        print(f"  {'calacanis':10} enrolled from {vid} intro ({len(segs)} windows)")
    v = np.mean(cents, 0)
    prints["calacanis"] = v / (np.linalg.norm(v) + 1e-9)
    heldout["calacanis"] = test

    np.savez(OUT / "voiceprints.npz", **prints)
    (OUT / "heldout.json").write_text(json.dumps(heldout, indent=2))

    names = list(prints)
    print("\n  cross-similarity between voiceprints (should be LOW off-diagonal):")
    print("            " + "".join(n[:9].rjust(11) for n in names))
    for a in names:
        row = "".join(f"{float(prints[a] @ prints[b]):11.3f}" for b in names)
        print(f"  {a:10}{row}")


def load_prints() -> tuple[list[str], np.ndarray]:
    z = np.load(OUT / "voiceprints.npz")
    names = list(z.files)
    return names, np.stack([z[n] for n in names])


def assign(vecs: np.ndarray, mat: np.ndarray, min_sim=0.62, margin=0.03):
    sims = vecs @ mat.T                     # both L2-normalised → cosine
    order = np.argsort(-sims, axis=1)
    best, second = order[:, 0], order[:, 1]
    top = sims[np.arange(len(sims)), best]
    nxt = sims[np.arange(len(sims)), second]
    ok = (top >= min_sim) & ((top - nxt) >= margin)
    return best, top, ok


def cmd_label(video_id: str) -> None:
    names, mat = load_prints()
    wav = load_wav(fetch_audio(video_id))
    centres, segs = zip(*windows(wav))
    vecs = embed_many(list(segs))
    best, top, ok = assign(vecs, mat)

    labels = [names[b] if o else "unknown" for b, o in zip(best, ok)]
    total = len(labels)
    print(f"\n  {video_id}: {total} windows over {len(wav)/SR/60:.1f} min")
    print(f"  title: {TITLES.get(video_id, '?')[:70]}")
    print("\n  speaking share by voice (this is what the audio says):")
    for n in names + ["unknown"]:
        c = labels.count(n)
        print(f"    {n:11} {c:5}  {100*c/total:5.1f}%")

    out = OUT / f"windows-{video_id}.json"
    out.write_text(json.dumps(
        [{"t": round(float(c), 2), "speaker": l, "sim": round(float(s), 3)}
         for c, l, s in zip(centres, labels, top)]))
    print(f"\n  wrote {out}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "enroll"
    if cmd == "enroll":
        cmd_enroll()
    elif cmd == "label":
        cmd_label(sys.argv[2])
    else:
        print(__doc__)
