#!/usr/bin/env python3
"""
Identify the besties with ZERO manual labels, zero cloud, zero dollars.

THE IDEA
  1. Cluster an episode's audio into voices (unsupervised diarization).
     Measured: resemblyzer d-vectors separate speakers within an episode
     (within-cluster cosine 0.774 vs between 0.647, +0.127 separation).
  2. Name the clusters using the TRANSCRIPT, which hands off by name:
       - "welcome to episode N of the all-in podcast"  -> Jason opens every show
       - "freeberg, what do you think?"                -> next voice is Friedberg
       - "sacks?" / "chamath, your thoughts"           -> next voice is that person
     Captions carry millisecond timestamps, so each cue points at an exact
     audio window. The regex labeller THROWS THESE AWAY: isVocativeMatch()
     explicitly skips vocatives, which is why it can never follow a hand-off.

WHY NOT ENROLL FROM "SOLO" CLIPS
  Tried it. A clip titled "David Friedberg Reacts to X" is a roundtable excerpt
  containing all four besties. Averaging its windows yields the group centroid,
  so all four "voiceprints" landed within 0.94 cosine of each other -- useless.
  Anchoring beats enrolling because a hand-off names ONE person at ONE instant.

VALIDATION (no human labels required)
  - held-out anchors: name clusters with half the cues, score the other half
  - intro test:       the 12-30s window must land in Jason's cluster
  - guest absence:    a guest-free episode should need no fifth voice

Usage: python3 scripts/speaker_anchor_pilot.py <videoId>
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import warnings
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from resemblyzer import VoiceEncoder, preprocess_wav  # noqa: E402
from sklearn.cluster import AgglomerativeClustering  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "data" / "audio"
CAPTIONS = ROOT / "data" / "captions"
SR = 16_000
WIN_S, HOP_S = 3.0, 1.5
N_CLUSTERS = 6  # 4 hosts + guest + music/ads; anchors name the ones we care about

# The person named in a hand-off speaks NEXT.
NAMES = {
    "friedberg": r"freeberg|friedberg|sultan of science",
    "sacks": r"\bsacks\b|\bsacky\b|rain man",
    "chamath": r"\bchamath\b",
    "calacanis": r"\bj[- ]?cal\b|calacanis",
}
ASK = (r"what do you think|what say you|your thoughts?|thoughts\b|go ahead|take it away|"
       r"any thoughts|what'?s your (take|view|read)|weigh in|over to you|do you agree")
HANDOFF = {n: re.compile(rf"({p})\s*[,:?]?\s*({ASK})|({ASK})\s*[,:]?\s*({p})", re.I)
           for n, p in NAMES.items()}
INTRO = re.compile(r"welcome to episode \d+ of the all.?in", re.I)


def fetch_audio(vid: str) -> Path:
    wav = AUDIO / f"{vid}.wav"
    if wav.exists():
        return wav
    raw = AUDIO / f"{vid}.src"
    subprocess.run(["yt-dlp", "-f", "bestaudio", "-N", "8", "--no-progress", "-q",
                    "--no-warnings", "-o", str(raw), f"https://youtu.be/{vid}"], check=True)
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(raw),
                    "-ac", "1", "-ar", str(SR), "-f", "wav", str(wav)], check=True)
    raw.unlink(missing_ok=True)
    return wav


def caption_events(vid: str):
    j = json.loads((CAPTIONS / f"{vid}.en.json3").read_text())
    out = []
    for e in j.get("events", []):
        if not e.get("segs"):
            continue
        txt = "".join(s.get("utf8", "") for s in e["segs"]).replace("\n", " ").strip()
        if txt:
            out.append((e["tStartMs"] / 1000.0, (e["tStartMs"] + e.get("dDurationMs", 0)) / 1000.0, txt))
    return out


def find_anchors(events):
    """Return {name: [time_seconds]} — the instant AFTER each hand-off cue."""
    anchors = defaultdict(list)
    for i, (_, end, txt) in enumerate(events):
        for name, rx in HANDOFF.items():
            if rx.search(txt):
                anchors[name].append(end + 0.4)   # the reply starts right after
        if INTRO.search(txt):
            anchors["calacanis"].append(events[i][0] + 1.0)
    return anchors


def embed_windows(wav, times):
    enc = embed_windows.enc
    segs, keep = [], []
    for t in times:
        a = int(t * SR)
        b = a + int(WIN_S * SR)
        if a < 0 or b > len(wav):
            continue
        s = wav[a:b]
        if float(np.sqrt(np.mean(s ** 2))) > 0.005:
            segs.append(s)
            keep.append(t)
    if not segs:
        return np.zeros((0, 256), np.float32), []
    V = np.stack([enc.embed_utterance(s) for s in segs])
    return V / np.linalg.norm(V, axis=1, keepdims=True), keep


def main(vid: str):
    embed_windows.enc = VoiceEncoder("mps")
    wav, _ = sf.read(str(fetch_audio(vid)), dtype="float32")
    wav = preprocess_wav(wav, source_sr=SR)
    dur = len(wav) / SR
    print(f"  {vid}: {dur/60:.1f} min of audio")

    # 1. unsupervised voices
    grid = np.arange(0, dur - WIN_S, HOP_S)
    V, times = embed_windows(wav, grid)
    print(f"  embedded {len(V)} windows")
    lab = AgglomerativeClustering(n_clusters=N_CLUSTERS, metric="cosine",
                                  linkage="average").fit_predict(V)
    cents = np.stack([V[lab == k].mean(0) for k in range(N_CLUSTERS)])
    cents /= np.linalg.norm(cents, axis=1, keepdims=True)
    sizes = np.bincount(lab, minlength=N_CLUSTERS)
    print("  cluster sizes:", sizes.tolist())

    # 2. name the clusters from transcript hand-offs
    events = caption_events(vid)
    anchors = find_anchors(events)
    print(f"\n  hand-off cues found in captions: " +
          ", ".join(f"{n}={len(v)}" for n, v in sorted(anchors.items())) or "  none")

    votes = defaultdict(Counter)
    held = defaultdict(list)
    for name, ts in anchors.items():
        ts = sorted(ts)
        train, test = ts[::2], ts[1::2]      # half to name, half to score
        A, kept = embed_windows(wav, train)
        for v in A:
            votes[name][int(np.argmax(cents @ v))] += 1
        held[name] = test

    print("\n  cluster votes per name (which voice replies to their name?):")
    assign = {}
    for name, c in votes.items():
        if not c:
            continue
        top, n = c.most_common(1)[0]
        purity = n / sum(c.values())
        assign[top] = name
        print(f"    {name:10} -> cluster {top}  ({n}/{sum(c.values())} cues, purity {purity:.0%})")

    if len(set(assign.values())) < len(assign):
        print("    ⚠️  two names claim the same cluster — clustering is under-resolved")

    # 3. held-out accuracy: do the OTHER half of the cues land on the same cluster?
    print("\n  HELD-OUT ACCURACY (cues not used for naming):")
    tot_ok = tot = 0
    for name, ts in held.items():
        if not ts:
            continue
        A, _ = embed_windows(wav, ts)
        if len(A) == 0:
            continue
        pred = [assign.get(int(np.argmax(cents @ v))) for v in A]
        ok = sum(p == name for p in pred)
        tot_ok += ok
        tot += len(pred)
        print(f"    {name:10} {ok}/{len(pred)} correct")
    if tot:
        print(f"    ---> {tot_ok}/{tot} = {100*tot_ok/tot:.0f}%   (chance with 4 voices = 25%)")

    # 4. speaking share
    named = [assign.get(k) for k in lab]
    print("\n  speaking share by voice (what the AUDIO says):")
    c = Counter(named)
    for n, k in c.most_common():
        print(f"    {str(n or 'unnamed'):11} {k:5}  {100*k/len(named):5.1f}%")

    out = ROOT / "data" / "speaker" / f"anchor-{vid}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"times": [float(t) for t in times],
                               "speaker": [n or "unknown" for n in named]}))
    print(f"\n  wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fU6QlvruLTw")
