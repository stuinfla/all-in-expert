#!/usr/bin/env python3
"""
Name the four voices, using no human labels, no cloud, no money.

METHOD (assignment)
  People almost never say their own name. That is exactly why the existing
  name-mention regex is anti-correlated with the truth -- and inverted, it is a
  free statistical anchor.

    1. Per episode: KMeans(k=4) over 3s window embeddings -> four voices.
    2. Link voices across episodes: Hungarian-match each episode's centroids to
       a running global centroid set, so "voice 2" means the same person in
       every episode.
    3. Count each bestie's REAL NAME in the transcript while each global voice
       is speaking. Assign names by minimum self-mention (Hungarian).

VALIDATION (shares nothing with the assignment)
  The show hands off by nickname, and the person named speaks NEXT:
      "sultan of science" / "science corner" -> Friedberg
      "rain man"                             -> Sacks
      "dictator"                             -> Chamath
  Nicknames are excluded from the assignment counts, so scoring on them is
  honest. Chance = 25%.

  Second, independent check: Jason opens every episode, so the 12-40s window
  must land in whichever voice was named `calacanis`.

Usage: python3 scripts/spk_name_clusters.py
"""
from __future__ import annotations

import json
import re
import warnings
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from scipy.optimize import linear_sum_assignment  # noqa: E402
from sklearn.cluster import KMeans  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CAPS = ROOT / "data" / "captions"
EMB = ROOT / "data" / "speaker"
K = 4
WIN_S = 3.0

# ASSIGNMENT signal: real names only. No nicknames — they are the test set.
NAMES = {
    "chamath": r"\bchamath\b|palihapitiya",
    "sacks": r"\bsacks\b|\bsacky\b",
    "friedberg": r"\bfriedberg\b|\bfreeberg\b",
    "calacanis": r"\bjason\b|\bcalacanis\b|\bj-?cal\b",
}
# VALIDATION signal: nicknames only. The named person speaks next.
NICKS = {
    "friedberg": r"sultan of science|science corner|queen of quinoa",
    "sacks": r"\brain man\b",
    "chamath": r"\bdictator\b",
}
NAME_LIST = list(NAMES)


def caption_stream(vid: str):
    """Joined lowercase text + (char_offset -> seconds) map, and per-event spans."""
    j = json.loads((CAPS / f"{vid}.en.json3").read_text())
    ev = []
    for e in j.get("events", []):
        if not e.get("segs"):
            continue
        t = "".join(s.get("utf8", "") for s in e["segs"]).replace("\n", " ").strip()
        if t:
            ev.append((e["tStartMs"] / 1000.0,
                       (e["tStartMs"] + e.get("dDurationMs", 0)) / 1000.0, t))
    text, marks = "", []
    for a, b, t in ev:
        if text:
            text += " "
        marks.append((len(text), a, b))
        text += t
    return text.lower(), marks, ev


def char_to_time(marks, ch: int) -> float:
    lo, hi = 0, len(marks) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if marks[mid][0] <= ch:
            lo = mid
        else:
            hi = mid - 1
    return marks[lo][2]  # end of the event containing this char


def window_text(ev, t: float) -> str:
    out = []
    for a, b, s in ev:
        if b < t:
            continue
        if a > t + WIN_S:
            break
        out.append(s)
    return " ".join(out).lower()


def main() -> None:
    files = sorted(EMB.glob("emb-*.npz"))
    print(f"  episodes with cached embeddings: {len(files)}")

    global_cent = None
    counts = np.zeros((K, len(NAME_LIST)))
    words = np.zeros(K)
    per_ep = {}     # vid -> (T, global_label)

    for f in files:
        vid = f.name[4:-4]
        if not (CAPS / f"{vid}.en.json3").exists():
            continue
        z = np.load(f)
        V, T = z["V"], z["T"]
        if len(V) < 200:
            continue
        lab = KMeans(K, n_init=10, random_state=0).fit_predict(V)
        cent = np.stack([V[lab == k].mean(0) for k in range(K)])
        cent /= np.linalg.norm(cent, axis=1, keepdims=True)

        if global_cent is None:
            global_cent = cent.copy()
            perm = np.arange(K)
        else:
            # Hungarian: maximise cosine == minimise (1 - cosine)
            r, c = linear_sum_assignment(1.0 - global_cent @ cent.T)
            perm = np.empty(K, int)
            perm[c] = r                       # local cluster c -> global voice r
            for lo, gi in zip(c, r):
                global_cent[gi] = 0.9 * global_cent[gi] + 0.1 * cent[lo]
            global_cent /= np.linalg.norm(global_cent, axis=1, keepdims=True)

        glab = perm[lab]
        per_ep[vid] = (T, glab)

        _, _, ev = caption_stream(vid)
        for t, g in zip(T, glab):
            s = window_text(ev, float(t))
            words[g] += len(s.split())
            for ni, n in enumerate(NAME_LIST):
                counts[g, ni] += len(re.findall(NAMES[n], s))

    rate = counts / np.maximum(words, 1)[:, None] * 1000
    print("\n  mention rate per 1000 words   (row = voice, col = name mentioned)")
    print("          " + "".join(n[:9].rjust(11) for n in NAME_LIST))
    for g in range(K):
        print(f"  voice{g}  " + "".join(f"{rate[g, i]:11.3f}" for i in range(K))
              + f"   [{int(words[g]):,} words]")

    r, c = linear_sum_assignment(rate)          # a person says their own name least
    assign = {int(r[i]): NAME_LIST[c[i]] for i in range(K)}
    print("\n  ASSIGNMENT by minimum self-mention:")
    for g in sorted(assign):
        own = rate[g, NAME_LIST.index(assign[g])]
        others = [rate[g2, NAME_LIST.index(assign[g])] for g2 in range(K) if g2 != g]
        print(f"    voice{g} -> {assign[g]:11} self={own:.3f}  others say it {np.mean(others):.3f}"
              f"  ({np.mean(others)/max(own,1e-6):.1f}x more)")

    # ── validation 1: nickname hand-offs (never used above) ──────────────────
    print("\n  VALIDATION on nickname hand-offs (independent signal, chance = 25%):")
    tally = Counter()
    per_name = defaultdict(lambda: [0, 0])
    for vid, (T, glab) in per_ep.items():
        text, marks, _ = caption_stream(vid)
        for who, pat in NICKS.items():
            for m in re.finditer(pat, text):
                t_end = char_to_time(marks, m.end())
                idx = np.searchsorted(T, t_end + 0.4)
                if idx >= len(T) or T[idx] - t_end > 6.0:
                    continue
                pred = assign.get(int(glab[idx]))
                per_name[who][1] += 1
                if pred == who:
                    per_name[who][0] += 1
                tally[(who, pred)] += 1
    tot_ok = sum(v[0] for v in per_name.values())
    tot = sum(v[1] for v in per_name.values())
    for who, (ok, n) in sorted(per_name.items()):
        print(f"    {who:11} {ok:4}/{n:4} = {100*ok/max(n,1):5.1f}%")
    if tot:
        print(f"    {'TOTAL':11} {tot_ok:4}/{tot:4} = {100*tot_ok/tot:5.1f}%")

    # ── validation 2: Jason opens every episode ─────────────────────────────
    ok = n = 0
    for vid, (T, glab) in per_ep.items():
        sel = [g for t, g in zip(T, glab) if 12 <= t <= 40]
        if not sel:
            continue
        top, _ = Counter(sel).most_common(1)[0]
        n += 1
        ok += assign.get(int(top)) == "calacanis"
    print(f"\n  VALIDATION on the intro (Jason opens the show): {ok}/{n} episodes")

    share = Counter()
    for _, (_, glab) in per_ep.items():
        share.update(glab.tolist())
    total = sum(share.values())
    print("\n  speaking share across these episodes (what the AUDIO says):")
    for g, cnt in share.most_common():
        print(f"    {assign[g]:11} {100*cnt/total:5.1f}%")

    (EMB / "voice-assignment.json").write_text(json.dumps(
        {"assign": {str(k): v for k, v in assign.items()},
         "episodes": list(per_ep)}, indent=2))
    np.save(EMB / "global-centroids.npy", global_cent)
    print(f"\n  wrote {EMB/'voice-assignment.json'} and global-centroids.npy")


if __name__ == "__main__":
    main()
