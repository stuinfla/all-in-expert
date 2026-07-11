#!/usr/bin/env python3
"""
Real diarization with sherpa-onnx. No Hugging Face, no token, no login.

WHY THIS AND NOT THE EARLIER ATTEMPTS
  Fixed 3s windows + KMeans is not diarization. In a 4-way interrupting round
  table most windows are BLENDS -- even Jason's intro window was only 70% one
  voice, so we were comparing blends to blends (resemblyzer margin +0.025, ECAPA
  +0.006, both ~chance). Diarization does it properly: segmentation finds the
  speaker-change boundaries FIRST, embeds only clean single-speaker spans, then
  clusters those. sherpa-onnx bundles pyannote segmentation-3.0 + a 3D-Speaker
  embedding model, downloaded ungated from GitHub releases.

TEST (unchanged, so results are comparable)
  Jason opens every episode. The 12-40s span must fall in ONE diarized speaker,
  and that speaker must be the SAME one across episodes. We measure purity of the
  intro span (should now be >>0.70) and cross-episode nearest-neighbour on the
  per-speaker embeddings sherpa gives us.

Usage: python3 scripts/spk_diarize.py <videoId> [<videoId> ...]
"""
from __future__ import annotations

import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import sherpa_onnx  # noqa: E402
import soundfile as sf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "data" / "audio"
MODELS = ROOT / "data" / "speaker" / "models"
OUT = ROOT / "data" / "speaker"
SR = 16_000

SEG = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB = MODELS / "emb.onnx"

AUDIO.mkdir(parents=True, exist_ok=True)


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


def make_diarizer(num_speakers: int = -1):
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEG))),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMB)),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=num_speakers if num_speakers > 0 else -1,
            threshold=0.5 if num_speakers <= 0 else 0.0),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        raise RuntimeError("invalid diarization config")
    return sherpa_onnx.OfflineSpeakerDiarization(cfg)


def diarize(vid: str, num_speakers: int = -1):
    wav, _ = sf.read(str(fetch(vid)), dtype="float32")
    d = make_diarizer(num_speakers)
    res = d.process(wav).sort_by_start_time()
    segs = [(s.start, s.end, s.speaker) for s in res]
    return wav, segs


def intro_purity(segs, lo=12.0, hi=40.0):
    """Fraction of the intro span covered by its single dominant speaker."""
    dur = {}
    for a, b, spk in segs:
        ov = max(0.0, min(b, hi) - max(a, lo))
        if ov > 0:
            dur[spk] = dur.get(spk, 0.0) + ov
    if not dur:
        return None, 0.0
    top = max(dur, key=dur.get)
    return top, dur[top] / max(sum(dur.values()), 1e-9)


def main(vids):
    print(f"  diarizing {len(vids)} episode(s) with sherpa-onnx (ungated)\n")
    for vid in vids:
        try:
            wav, segs = diarize(vid)
        except Exception as e:
            print(f"  {vid}: FAILED {str(e)[:80]}")
            continue
        n_spk = len({s for _, _, s in segs})
        total = sum(b - a for a, b, _ in segs)
        top, pur = intro_purity(segs)
        share = {}
        for a, b, spk in segs:
            share[spk] = share.get(spk, 0.0) + (b - a)
        order = sorted(share, key=share.get, reverse=True)
        print(f"  {vid}: {len(segs)} segments, {n_spk} speakers, {total/60:.1f} min voiced")
        print(f"    intro (12-40s) dominated by speaker {top}, purity {pur:.2f}  "
              f"(fixed-window baseline was 0.70)")
        print("    speaking share: " + "  ".join(
            f"spk{s}={100*share[s]/total:.0f}%" for s in order[:6]))
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"diar-{vid}.json").write_text(
            __import__("json").dumps([{"start": round(a, 2), "end": round(b, 2), "spk": s}
                                      for a, b, s in segs]))
        print(f"    wrote {OUT/f'diar-{vid}.json'}\n")


if __name__ == "__main__":
    vids = sys.argv[1:] or ["fU6QlvruLTw"]
    main(vids)
