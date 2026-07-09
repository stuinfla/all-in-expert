"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";

/* ─── Bestie photos (Wikimedia Commons, CC/PD) ─────────────────── */

const BESTIE_PHOTOS: Record<string, { src: string; credit: string; license: string }> = {
  chamath: {
    src: "/images/besties/chamath.jpg",
    credit: "Cmichel67",
    license: "CC BY-SA 4.0",
  },
  sacks: {
    src: "/images/besties/sacks.jpg",
    credit: "The White House",
    license: "Public Domain",
  },
  friedberg: {
    src: "/images/besties/friedberg.jpg",
    credit: "The Production Board",
    license: "CC BY-SA 4.0",
  },
  calacanis: {
    src: "/images/besties/jason.jpg",
    credit: "Preshdineshkumar",
    license: "CC BY-SA 4.0",
  },
};

/* ─── Symbolic bestie illustrations (fallback decoration) ──────── */

function ChamathArt() {
  // Capital flows — concentric rings + radial lines in burgundy
  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
      <defs>
        <radialGradient id="cgrad" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#c2413a" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6b1820" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="120" height="120" fill="url(#cgrad)" />
      {[48, 38, 28, 18].map((r, i) => (
        <circle key={r} cx="60" cy="60" r={r} fill="none" stroke="#a8312b" strokeWidth="1" strokeOpacity={0.4 + i * 0.12} />
      ))}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const rad = (a * Math.PI) / 180;
        return (
          <line
            key={a}
            x1={60 + 18 * Math.cos(rad)}
            y1={60 + 18 * Math.sin(rad)}
            x2={60 + 52 * Math.cos(rad)}
            y2={60 + 52 * Math.sin(rad)}
            stroke="#c6a15b"
            strokeWidth="0.6"
            strokeOpacity="0.5"
          />
        );
      })}
      <circle cx="60" cy="60" r="4" fill="#c6a15b" />
    </svg>
  );
}

function SacksArt() {
  // System grid — connected nodes in steel blue
  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id="sgrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4a7ea0" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#1f3c56" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" fill="url(#sgrad)" />
      {[20, 40, 60, 80, 100].map((x) =>
        [20, 40, 60, 80, 100].map((y) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" fill="#3a6b8c" opacity="0.6" />
        ))
      )}
      {/* Diagonal + horizontal connections */}
      {[
        [20, 20, 100, 100],
        [100, 20, 20, 100],
        [20, 60, 100, 60],
        [60, 20, 60, 100],
      ].map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3a6b8c" strokeWidth="0.8" strokeOpacity="0.5" />
      ))}
      <circle cx="60" cy="60" r="6" fill="none" stroke="#c6a15b" strokeWidth="1" />
      <circle cx="60" cy="60" r="2" fill="#c6a15b" />
    </svg>
  );
}

function FriedbergArt() {
  // Molecular hexagonal lattice in moss green
  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
      <defs>
        <radialGradient id="fgrad" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#95a86a" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3d4a26" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="120" height="120" fill="url(#fgrad)" />
      {/* Hexagonal ring pattern */}
      {(() => {
        const hexes = [];
        const cx = 60;
        const cy = 60;
        const r = 18;
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          hexes.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        return (
          <>
            <polygon
              points={hexes.map((p) => p.join(",")).join(" ")}
              fill="none"
              stroke="#7a8c52"
              strokeWidth="1.2"
              strokeOpacity="0.7"
            />
            {hexes.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="2.5" fill="#7a8c52" />
            ))}
          </>
        );
      })()}
      {/* Bonds to outer atoms */}
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={60 + 18 * Math.cos(rad)}
            y1={60 + 18 * Math.sin(rad)}
            x2={60 + 44 * Math.cos(rad)}
            y2={60 + 44 * Math.sin(rad)}
            stroke="#7a8c52"
            strokeWidth="0.8"
            strokeOpacity="0.5"
          />
        );
      })}
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <circle
            key={`o-${deg}`}
            cx={60 + 44 * Math.cos(rad)}
            cy={60 + 44 * Math.sin(rad)}
            r="3"
            fill="#c6a15b"
            fillOpacity="0.6"
          />
        );
      })}
    </svg>
  );
}

function JasonArt() {
  // Broadcast radial burst in burnt orange
  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
      <defs>
        <radialGradient id="jgrad" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#e09f50" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#6d4210" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="120" height="120" fill="url(#jgrad)" />
      {/* Radial burst — 24 rays */}
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i * 15 * Math.PI) / 180;
        const r1 = 14 + (i % 3) * 2;
        const r2 = 38 + (i % 4) * 4;
        return (
          <line
            key={i}
            x1={60 + r1 * Math.cos(a)}
            y1={60 + r1 * Math.sin(a)}
            x2={60 + r2 * Math.cos(a)}
            y2={60 + r2 * Math.sin(a)}
            stroke="#d88c3c"
            strokeWidth="1.2"
            strokeOpacity="0.65"
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="60" cy="60" r="10" fill="none" stroke="#d88c3c" strokeWidth="1.5" />
      <circle cx="60" cy="60" r="5" fill="#c6a15b" />
    </svg>
  );
}

const BESTIE_ART: Record<string, () => React.ReactElement> = {
  chamath: ChamathArt,
  sacks: SacksArt,
  friedberg: FriedbergArt,
  calacanis: JasonArt,
};

/* ─── Bestie roster ──────────────────────────────────────────────── */

interface Bestie {
  key: string;
  initial: string;
  name: string;
  short: string;
  role: string;
  lens: string;
  color: string;
  tier: "core" | "guest";
}

interface Citation {
  n: number;
  time: string;
  date?: string | null;
  videoId: string;
  url: string;
  topics: string[];
  speakers: string[];
  quote: string;
  relevance: number;
}

const BESTIES: Bestie[] = [
  {
    key: "chamath",
    initial: "C",
    name: "Chamath Palihapitiya",
    short: "Chamath",
    role: "Social Capital",
    lens: "Contrarian macro. Capital flows. Systemic risk.",
    color: "chamath",
    tier: "core",
  },
  {
    key: "sacks",
    initial: "S",
    name: "David Sacks",
    short: "Sacks",
    role: "Craft Ventures · WH AI Czar",
    lens: "Enterprise SaaS. Political power. Crypto policy.",
    color: "sacks",
    tier: "core",
  },
  {
    key: "friedberg",
    initial: "F",
    name: "David Friedberg",
    short: "Friedberg",
    role: "The Production Board",
    lens: "First principles. Science. Biotech.",
    color: "friedberg",
    tier: "core",
  },
  {
    key: "calacanis",
    initial: "J",
    name: "Jason Calacanis",
    short: "Jason",
    role: "LAUNCH · Host",
    lens: "Startups. Founders. Provocateur.",
    color: "jason",
    tier: "core",
  },
];

const GUEST_BESTIES = [
  { key: "gerstner", short: "Gerstner", role: "Altimeter" },
  { key: "gurley", short: "Gurley", role: "Benchmark" },
  { key: "baker", short: "Baker", role: "Atreides" },
  { key: "thiel", short: "Thiel", role: "Founders Fund" },
  { key: "ackman", short: "Ackman", role: "Pershing" },
  { key: "gracias", short: "Gracias", role: "Valor" },
  { key: "elon", short: "Elon", role: "Tesla/SpaceX" },
  { key: "naval", short: "Naval", role: "AngelList" },
  { key: "rabois", short: "Rabois", role: "Khosla" },
  { key: "lonsdale", short: "Lonsdale", role: "8VC" },
  { key: "cuban", short: "Cuban", role: "Mavericks" },
  { key: "kalanick", short: "Kalanick", role: "CloudKitchens" },
];

// Display-only floor for the visitor counter. Real count is stored
// accurately in pi-brain; this just sets the floor the public sees.
const VISITOR_OFFSET = 10001;

const EXAMPLE_QUERIES = [
  { q: "What's the current state of the AI market?", mode: "analysis" },
  { q: "How is AI reshaping the global economy?", mode: "forecast" },
  { q: "Will Anthropic hit $250B in revenue in the next year?", mode: "forecast" },
  { q: "Is the AI market heading for a monopoly?", mode: "forecast" },
  { q: "Should the FDA regulate AI like drugs?", mode: "analysis" },
  { q: "How do you trade the AI boom right now?", mode: "analysis" },
];

/* ─── Markdown renderer (report text from our API only) ─────────── */

function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.*$)/gm, "<h3>$1</h3>")
    .replace(/^## (.*$)/gm, "<h2>$1</h2>")
    .replace(/^# (.*$)/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/^- (.*$)/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/^---$/gm, "<hr />")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(https:\/\/youtube\.com\/watch\?[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">youtube</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n\n/g, "</p><p>");
}

/* ─── Loading state typewriter phrases ──────────────────────────── */

const LOADING_PHRASES = [
  "Pulling dossiers from the archive",
  "The besties are deliberating",
  "Cross-referencing 186 episodes",
  "Synthesizing positions",
  "Assembling citations",
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [mode, setMode] = useState<"analysis" | "forecast">("analysis");
  // strictSpeaker: when a single bestie is selected, restrict retrieval to
  // ONLY their chunks (skip the unfiltered topic-interleave). Defaults ON
  // whenever a speaker is selected — the user picked one bestie, they want
  // that bestie's voice. The API echoes back `strictMode` to confirm.
  const [strictSpeaker, setStrictSpeaker] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [meta, setMeta] = useState<{
    segmentsFound?: number;
    totalEntries?: number;
    searchMode?: string;
    strictMode?: boolean;
    dataFreshness?: { newestEpisodeDate: string | null; totalEpisodes: number; totalChunks: number } | null;
  }>({});
  // Post-gen claim verifier output. Hidden when the API response omits the
  // `verification` block (older cached responses pre-verifier-rollout).
  const [verification, setVerification] = useState<{
    claimsTotal: number;
    claimsGrounded: number;
    claimsInferred: number;
    claimsUngrounded: number;
    hedgesApplied: boolean;
    verificationMs: number;
  } | null>(null);
  const [disclaimer, setDisclaimer] = useState<string>("");
  const [timing, setTiming] = useState<{
    retrieveMs: number;
    rerankMs: number;
    synthesisMs: number;
    totalMs: number;
  } | null>(null);
  const [copyright, setCopyright] = useState<string>("");
  const [showRetrievalExplain, setShowRetrievalExplain] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [loadingPhrase, setLoadingPhrase] = useState(0);
  const [freshness, setFreshness] = useState<{
    updatedAt?: string;
    episodeCount?: number;
    chapterCount?: number;
    latestEpisode?: { title: string; date: string };
  } | null>(null);
  const [engagement, setEngagement] = useState<{
    visitors: number;
    ratings: { count: number; avg: number };
  } | null>(null);
  const [budget, setBudget] = useState<{
    count: number;
    limit: number;
    remaining: number;
  } | null>(null);
  const [userRating, setUserRating] = useState<number | null>(null);
  const [ratingHover, setRatingHover] = useState<number | null>(null);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const selectedBestie = useMemo(
    () => BESTIES.find((b) => b.key === speaker) || null,
    [speaker]
  );

  // Cycle loading phrases
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => {
      setLoadingPhrase((p) => (p + 1) % LOADING_PHRASES.length);
    }, 1800);
    return () => clearInterval(t);
  }, [loading]);

  // Reset strict-speaker to its default (ON) whenever the user changes
  // bestie. Picking a fresh bestie implies wanting that bestie's voice,
  // not whatever the toggle was set to for the previous bestie.
  useEffect(() => {
    setStrictSpeaker(true);
  }, [speaker]);

  // Load freshness on mount
  useEffect(() => {
    fetch("/api/chapters?weeks=1&limit=1")
      .then((r) => r.json())
      .then((d) => setFreshness(d.freshness))
      .catch(() => {});
  }, []);

  // Engagement: record a visit once per browser session + load stats
  useEffect(() => {
    const loadStats = () =>
      fetch("/api/stats")
        .then((r) => r.json())
        .then((d) => {
          if (d?.engagement) setEngagement(d.engagement);
          if (d?.budget) setBudget(d.budget);
        })
        .catch(() => {});

    const SESSION_KEY = "aie_visit_recorded";
    const RATING_KEY = "aie_user_rating";
    try {
      // Load real counts immediately so the number appears fast — do NOT gate it
      // behind the visit POST (that round-trip was the source of the stale-number lag).
      loadStats();
      if (!sessionStorage.getItem(SESSION_KEY)) {
        sessionStorage.setItem(SESSION_KEY, "1");
        // Bump the counter once per session, then refresh stats when it lands.
        fetch("/api/visit", { method: "POST" })
          .then(() => loadStats())
          .catch(() => {});
      }
      const prior = localStorage.getItem(RATING_KEY);
      if (prior) {
        setUserRating(parseInt(prior, 10));
        setRatingSubmitted(true);
      }
    } catch {
      loadStats();
    }
  }, []);

  async function submitRating(stars: number) {
    if (ratingSubmitted) return;
    setUserRating(stars);
    try {
      const res = await fetch("/api/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars }),
      });
      if (res.ok) {
        const data = await res.json();
        setEngagement((prev) => ({
          visitors: prev?.visitors ?? 0,
          ratings: { count: data.count, avg: data.avg },
        }));
        try { localStorage.setItem("aie_user_rating", String(stars)); } catch {}
        setRatingSubmitted(true);
      }
    } catch {
      // no-op — user can retry
    }
  }

  // Auto-resize textarea
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = "auto";
    inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + "px";
  }, [query]);

  // Scroll to report
  useEffect(() => {
    if (report && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [report]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setStreaming(false);
    setError("");
    setReport("");
    setCitations([]);
    setDisclaimer("");
    setVerification(null);
    setLoadingPhrase(0);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Opt into Server-Sent Events. The route returns text/event-stream
          // with `start` / `delta` / `complete` / `error` events when this
          // header is present; otherwise it falls back to a JSON response.
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          query: query.trim(),
          speaker,
          mode,
          // Only honored server-side when `speaker` is also set. We forward
          // the current toggle value regardless so the cache key matches.
          strictSpeaker: Boolean(speaker) && strictSpeaker,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError(
            data.message ||
              `Daily research budget reached (${data.limit || 25} new syntheses). Resets at UTC midnight. Try a question that's been asked before — cached answers are unlimited.`
          );
          if (typeof data.limit === "number") {
            setBudget({ count: data.count ?? data.limit, limit: data.limit, remaining: 0 });
          }
        } else {
          setError(data.error || "Something went wrong");
        }
        return;
      }

      const contentType = res.headers.get("content-type") || "";

      // ─── Streaming path (SSE) ───────────────────────────────────
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("");
            if (!dataLine) continue;

            try {
              const evt = JSON.parse(dataLine);
              if (evt.type === "start") {
                setStreaming(true);
                setLoading(false);
                if (evt.disclaimer) setDisclaimer(evt.disclaimer);
                if (evt.segmentsFound !== undefined) {
                  setMeta((m) => ({ ...m, segmentsFound: evt.segmentsFound }));
                }
              } else if (evt.type === "delta" && typeof evt.text === "string") {
                accumulated += evt.text;
                setReport(accumulated);
              } else if (evt.type === "complete") {
                // Final cleaned report replaces the streamed preview;
                // validation may have stripped unsupported [N] markers.
                if (typeof evt.report === "string") setReport(evt.report);
                setCitations(evt.citations || []);
                setMeta({
                  segmentsFound: evt.segmentsFound,
                  totalEntries: evt.totalEntries,
                  searchMode: evt.searchMode,
                  strictMode: Boolean(evt.strictMode),
                  dataFreshness: evt.dataFreshness ?? null,
                });
                if (evt.disclaimer) setDisclaimer(evt.disclaimer);
                if (evt.budget) setBudget(evt.budget);
                if (evt.timing) setTiming(evt.timing);
                if (evt.meta?.copyright) setCopyright(evt.meta.copyright);
                // Post-gen claim verifier block. Older cached responses omit
                // this field — leave verification null so the badge hides.
                if (evt.verification) setVerification(evt.verification);
                setStreaming(false);
              } else if (evt.type === "error") {
                setError(evt.error || "Stream interrupted");
                setStreaming(false);
              }
            } catch {
              /* malformed frame — skip */
            }
          }
        }
        return;
      }

      // ─── Non-streaming JSON fallback ────────────────────────────
      const data = await res.json();
      setReport(data.report);
      setCitations(data.citations || []);
      setMeta({
        segmentsFound: data.segmentsFound,
        totalEntries: data.totalEntries,
        searchMode: data.searchMode,
        strictMode: Boolean(data.strictMode),
        dataFreshness: data.dataFreshness ?? null,
      });
      if (data.disclaimer) setDisclaimer(data.disclaimer);
      if (data.budget) setBudget(data.budget);
      if (data.timing) setTiming(data.timing);
      if (data.meta?.copyright) setCopyright(data.meta.copyright);
      // Older cached responses omit `verification` — leave state null so the
      // FACT-CHECK block hides silently.
      if (data.verification) setVerification(data.verification);
    } catch {
      setError("Unable to reach the archive.");
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  }

  function useExample(q: string, m: string) {
    setQuery(q);
    setMode(m as "analysis" | "forecast");
    inputRef.current?.focus();
  }

  function clearReport() {
    setReport("");
    setCitations([]);
    setMeta({});
    setDisclaimer("");
    setError("");
    setTiming(null);
    setCopyright("");
    setVerification(null);
    setShowRetrievalExplain(false);
  }

  function speakerDisplayName(key: string): string {
    const allKeys: Record<string, string> = {
      chamath: "Chamath", sacks: "Sacks", friedberg: "Friedberg", calacanis: "Jason",
      gerstner: "Gerstner", gurley: "Gurley", baker: "Baker", thiel: "Thiel",
      ackman: "Ackman", gracias: "Gracias", rabois: "Rabois", lonsdale: "Lonsdale",
      naval: "Naval", elon: "Elon", tucker: "Tucker", kalanick: "Kalanick",
      cuban: "Cuban", shapiro: "Shapiro", saagar: "Saagar",
    };
    return allKeys[key] || key;
  }

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-[var(--border)] relative">
        <div className="max-w-5xl mx-auto px-6 pt-10 pb-8 sm:pt-14 sm:pb-12">
          {/* Top nav */}
          <nav className="flex items-center justify-between mb-8 gap-3 flex-wrap">
            <div className="flex items-center gap-4">
              <div className="eyebrow">№ 01 · Intelligence Dossier</div>
            </div>
            <Link
              href="/chapters"
              className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition border border-[var(--border)] px-3 py-1.5 hover:border-[var(--gold-rule)]"
            >
              Episode Archive →
            </Link>
          </nav>

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-5xl sm:text-7xl leading-[0.92] tracking-tight">
                Ask the
                <br />
                <span className="text-[var(--gold-bright)] font-display-italic">
                  All-In
                </span>{" "}
                <span className="font-display">Experts</span>
              </h1>
              <p className="mt-5 text-[var(--ink-dim)] text-base sm:text-lg max-w-xl leading-relaxed">
                Intelligence synthesized from{" "}
                <span className="text-[var(--gold)] font-mono text-sm tracking-wider">
                  {freshness?.episodeCount ? `${freshness.episodeCount}+` : "186+"} EPISODES
                </span>{" "}
                ·{" "}
                <span className="text-[var(--gold)] font-mono text-sm tracking-wider">
                  5.8M WORDS
                </span>
                . Four minds, plus the guests that shape the conversation.
              </p>

              {/* Freshness badge */}
              {freshness?.latestEpisode && (
                <div className="mt-5 inline-flex items-center gap-3 px-4 py-2 border border-[var(--border-gold)] bg-[var(--gold-soft)]">
                  <span className="w-2 h-2 rounded-full bg-[var(--gold)] anim-shimmer"></span>
                  <div className="font-mono text-[9px] sm:text-[10px] tracking-widest uppercase">
                    <span className="text-[var(--gold-bright)]">Updated</span>{" "}
                    <span className="text-[var(--ink)]">
                      {freshness.updatedAt
                        ? new Date(freshness.updatedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : ""}
                    </span>
                    <span className="text-[var(--ink-mute)]"> · Latest: </span>
                    <span className="text-[var(--ink)]">
                      {new Date(freshness.latestEpisode.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </div>
              )}

              {/* Visitor counter — live engagement signal */}
              <div className="mt-3 inline-flex items-center gap-3 px-4 py-2 border border-[var(--border)] bg-[var(--bg-elev)] ml-0 sm:ml-3">
                <span className="w-2 h-2 rounded-full bg-[var(--gold)] anim-shimmer"></span>
                <div className="font-mono text-[9px] sm:text-[10px] tracking-widest uppercase">
                  <span className="text-[var(--gold-bright)]">
                    {engagement ? (engagement.visitors + VISITOR_OFFSET).toLocaleString() : "—"}
                  </span>{" "}
                  <span className="text-[var(--ink-mute)]">viewers</span>
                </div>
              </div>
            </div>
            <div className="hidden sm:flex flex-col items-end gap-1 text-right">
              <div className="font-mono text-[10px] tracking-[0.2em] text-[var(--ink-mute)] uppercase">
                Vol. I
              </div>
              <div className="font-display text-2xl text-[var(--gold)]">✦</div>
              <div className="font-mono text-[10px] tracking-[0.2em] text-[var(--ink-mute)] uppercase">
                MMXXVI
              </div>
            </div>
          </div>

          <div className="rule-gold mt-10" />
        </div>
      </header>

      {/* ─── Main content ───────────────────────────────────────── */}
      <div className="flex-1 max-w-5xl mx-auto px-6 py-10 sm:py-14 w-full">
        {/* Bestie selector ─── */}
        <section className="mb-10">
          <div className="flex items-baseline justify-between mb-5">
            <div className="eyebrow">§ Select correspondent</div>
            {speaker && (
              <button
                onClick={() => setSpeaker(null)}
                className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition"
              >
                Clear ✕
              </button>
            )}
          </div>

          {/* Core besties — 5 columns: ALL + 4 */}
          <div className="grid grid-cols-5 gap-3 sm:gap-4">
            {/* ALL card — All-In Podcast logo */}
            <button
              onClick={() => setSpeaker(null)}
              className="group relative border text-left transition-all duration-300 overflow-hidden"
              style={{
                borderColor: !speaker ? "var(--gold)" : "var(--border)",
                background: "var(--bg-card)",
              }}
              aria-label="Ask all four besties (The Council)"
            >
              {/* All-In logo backdrop */}
              <img
                src="/icon-512.png"
                alt=""
                className="absolute inset-0 w-full h-full object-contain p-3 sm:p-5 opacity-95 group-hover:opacity-100 transition-opacity duration-500"
                loading="eager"
              />

              {/* Gold tint overlay */}
              <div
                className="absolute inset-0 mix-blend-multiply opacity-20 group-hover:opacity-10 transition-opacity duration-500 pointer-events-none"
                style={{
                  background:
                    "linear-gradient(180deg, transparent 30%, var(--gold) 130%)",
                }}
              />

              {/* Bottom shadow for text readability */}
              <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none" />

              {/* Selection ring */}
              {!speaker && (
                <div
                  className="absolute inset-0 border-2 pointer-events-none"
                  style={{ borderColor: "var(--gold)" }}
                />
              )}

              {/* Foreground content — matches bestie card layout */}
              <div className="relative p-3 sm:p-4 min-h-[140px] sm:min-h-[200px] flex flex-col justify-end">
                <div
                  className="mt-2 font-mono text-[10px] tracking-widest uppercase font-semibold"
                  style={{ color: !speaker ? "var(--gold)" : "#fff" }}
                >
                  The Council
                </div>
                <div className="mt-0.5 text-[11px] sm:text-xs text-[#e5e5e5] leading-tight">
                  All four
                </div>
              </div>
            </button>

            {BESTIES.map((b) => {
              const selected = speaker === b.key;
              const cssVar = `var(--${b.color})`;
              const softVar = `var(--${b.color}-soft)`;
              const photo = BESTIE_PHOTOS[b.key];
              return (
                <button
                  key={b.key}
                  onClick={() => setSpeaker(b.key)}
                  className="group relative border text-left transition-all duration-300 overflow-hidden"
                  style={{
                    borderColor: selected ? cssVar : "var(--border)",
                    background: "var(--bg-card)",
                  }}
                >
                  {/* Real photo backdrop */}
                  {photo && (
                    <img
                      src={photo.src}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover object-top opacity-65 group-hover:opacity-85 transition-opacity duration-500"
                      loading="lazy"
                    />
                  )}

                  {/* Signature-color tint overlay */}
                  <div
                    className="absolute inset-0 mix-blend-multiply opacity-60 group-hover:opacity-40 transition-opacity duration-500"
                    style={{
                      background: `linear-gradient(180deg, transparent 30%, ${cssVar} 130%)`,
                    }}
                  />

                  {/* Bottom shadow for text readability */}
                  <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

                  {/* Selection ring */}
                  {selected && (
                    <div
                      className="absolute inset-0 border-2 pointer-events-none"
                      style={{ borderColor: cssVar }}
                    />
                  )}

                  {/* Foreground content */}
                  <div className="relative p-3 sm:p-4 min-h-[140px] sm:min-h-[200px] flex flex-col justify-end">
                    <div
                      className="mt-2 font-mono text-[10px] tracking-widest uppercase font-semibold"
                      style={{ color: selected ? cssVar : "#fff" }}
                    >
                      {b.short}
                    </div>
                    <div className="mt-0.5 text-[11px] sm:text-xs text-[#e5e5e5] leading-tight">
                      {b.role}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Guest besties row */}
          <div className="mt-5">
            <div className="eyebrow mb-3 text-[var(--ink-mute)]">
              ·· Frequent guests
            </div>
            <div className="flex flex-wrap gap-2">
              {GUEST_BESTIES.map((g) => {
                const selected = speaker === g.key;
                return (
                  <button
                    key={g.key}
                    onClick={() => setSpeaker(g.key)}
                    className={`px-3 py-1.5 text-xs border transition-all ${
                      selected
                        ? "border-[var(--gold)] bg-[var(--gold-soft)] text-[var(--gold-bright)]"
                        : "border-[var(--border)] bg-[var(--bg-card)] text-[var(--ink-dim)] hover:border-[var(--border-strong)] hover:text-[var(--ink)]"
                    }`}
                  >
                    <span className="font-display italic">{g.short}</span>
                    <span className="ml-1.5 font-mono text-[10px] text-[var(--ink-mute)]">
                      · {g.role}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Input area ─── */}
        <section className="mb-10">
          <div className="flex items-baseline justify-between mb-5">
            <div className="eyebrow">§ The question</div>
            <div className="flex gap-4">
              <button
                onClick={() => setMode("analysis")}
                className={`font-mono text-[10px] tracking-widest uppercase transition ${
                  mode === "analysis"
                    ? "text-[var(--gold)] border-b border-[var(--gold)]"
                    : "text-[var(--ink-mute)] hover:text-[var(--ink-dim)]"
                }`}
              >
                ☰ Analysis
              </button>
              <button
                onClick={() => setMode("forecast")}
                className={`font-mono text-[10px] tracking-widest uppercase transition ${
                  mode === "forecast"
                    ? "text-[var(--gold)] border-b border-[var(--gold)]"
                    : "text-[var(--ink-mute)] hover:text-[var(--ink-dim)]"
                }`}
              >
                ◈ Forecast
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="relative">
            <div className="relative border border-[var(--border-strong)] bg-[var(--bg-card)] focus-within:border-[var(--gold)] transition-colors duration-300">
              <textarea
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  mode === "forecast"
                    ? "What should the besties predict?"
                    : selectedBestie
                    ? `What would ${selectedBestie.short} think about…`
                    : "What would the besties think about…"
                }
                rows={1}
                disabled={loading}
                className="w-full px-6 py-5 pr-32 bg-transparent resize-none outline-none font-display text-lg sm:text-2xl placeholder:text-[var(--ink-mute)] placeholder:italic text-[var(--ink)] leading-snug"
                style={{ minHeight: "80px" }}
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="absolute right-3 bottom-3 sm:right-4 sm:bottom-4 px-5 py-2.5 bg-[var(--gold)] hover:bg-[var(--gold-bright)] text-[var(--bg)] font-mono text-[10px] tracking-[0.2em] uppercase font-semibold disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                {loading ? "···" : "Ask →"}
              </button>
            </div>
            <div className="mt-2 flex justify-between items-center font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase gap-3">
              <span>
                {selectedBestie
                  ? `Focus: ${selectedBestie.short}`
                  : speaker
                  ? `Focus: ${speakerDisplayName(speaker)}`
                  : "All four besties"}
              </span>
              {/* Strict speaker toggle — shown only when ONE bestie is
                  selected (core OR guest). Hidden for "All four". Defaults
                  ON because picking a single bestie implies wanting that
                  bestie's voice, not topic-only matches. */}
              {speaker && (
                <label
                  className="flex items-center gap-2 cursor-pointer select-none border border-[var(--gold-rule)] px-2.5 py-1 hover:border-[var(--gold)] transition-colors"
                  title="Only return chunks attributed to this bestie. Off = also include topic-matched chunks from other speakers."
                >
                  <input
                    type="checkbox"
                    checked={strictSpeaker}
                    onChange={(e) => setStrictSpeaker(e.target.checked)}
                    className="appearance-none w-3 h-3 border border-[var(--gold-rule)] checked:bg-[var(--gold)] checked:border-[var(--gold)] transition-colors"
                  />
                  <span
                    className={`tracking-[0.2em] ${
                      strictSpeaker ? "text-[var(--gold)]" : "text-[var(--ink-mute)]"
                    }`}
                  >
                    STRICT (only {speakerDisplayName(speaker)}&apos;s chunks)
                  </span>
                </label>
              )}
              <span className="hidden sm:inline">⌘ + ⏎ to submit</span>
            </div>
          </form>
        </section>

        {/* Examples ─── */}
        {!report && !loading && (
          <section className="mb-10 anim-fade-up">
            <div className="eyebrow mb-4">§ Try asking</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {EXAMPLE_QUERIES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => useExample(ex.q, ex.mode)}
                  className="group text-left p-4 border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--gold-rule)] hover:bg-[var(--bg-elev)] transition-all duration-300"
                >
                  <div className="flex items-start gap-3">
                    <span className="font-mono text-[10px] text-[var(--gold)] tracking-widest mt-1">
                      {ex.mode === "forecast" ? "◈" : "☰"}
                    </span>
                    <span className="font-display italic text-base text-[var(--ink)] group-hover:text-[var(--gold-bright)] transition leading-snug">
                      {ex.q}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Loading ─── */}
        {loading && (
          <section className="py-16 anim-fade-up">
            <div className="max-w-md mx-auto text-center">
              <div className="flex justify-center gap-3 mb-8">
                {BESTIES.map((b, i) => (
                  <div
                    key={b.key}
                    className={`w-12 h-12 border flex items-center justify-center font-display text-2xl anim-dot-${i + 1}`}
                    style={{
                      borderColor: `var(--${b.color})`,
                      color: `var(--${b.color})`,
                      background: `var(--${b.color}-soft)`,
                    }}
                  >
                    {b.initial}
                  </div>
                ))}
              </div>
              <div className="eyebrow mb-3">Transmission in progress</div>
              <div className="font-display italic text-xl text-[var(--ink)] min-h-[1.5em]">
                {LOADING_PHRASES[loadingPhrase]}
                <span className="anim-cursor">▊</span>
              </div>
            </div>
          </section>
        )}

        {/* Error ─── */}
        {error && (
          <section className="mb-8 anim-fade-up">
            <div className="border border-[var(--danger)] bg-[var(--chamath-soft)] p-5">
              <div className="eyebrow text-[var(--danger)] mb-2">⚠ Transmission failed</div>
              <div className="font-display italic text-[var(--ink)]">{error}</div>
            </div>
          </section>
        )}

        {/* Report ─── */}
        {report && (
          <section ref={reportRef} className="anim-fade-up">
            <div className="rule-gold-double mb-6" />

            {/* Corpus-freshness line — surfaced from the API so users know
                exactly how current the underlying transcript archive is. */}
            {meta.dataFreshness?.newestEpisodeDate && (
              <div className="mb-3 font-mono text-[10px] tracking-wider uppercase text-[var(--ink-mute)]">
                Corpus current as of {meta.dataFreshness.newestEpisodeDate}
                {" · "}
                {meta.dataFreshness.totalEpisodes.toLocaleString()} episodes
                {" · "}
                {meta.dataFreshness.totalChunks.toLocaleString()} chunks
              </div>
            )}

            <div className="flex items-baseline justify-between mb-6">
              <div>
                <div className="eyebrow">§ Intelligence brief</div>
                <div className="font-display italic text-2xl mt-1 text-[var(--ink)]">
                  {mode === "forecast" ? "Forecast" : "Analysis"}
                  {selectedBestie && (
                    <>
                      {" · "}
                      <span style={{ color: `var(--${selectedBestie.color})` }}>
                        {selectedBestie.short}
                      </span>
                    </>
                  )}
                  {/* Confirm to the user that the strict toggle was actually
                      applied server-side (echoed back as meta.strictMode). */}
                  {meta.strictMode && (
                    <span className="ml-3 font-mono text-[10px] tracking-[0.2em] uppercase text-[var(--gold)] border border-[var(--gold-rule)] px-2 py-0.5 align-middle">
                      Strict mode active
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={clearReport}
                className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition border border-[var(--border)] px-3 py-1.5"
              >
                New Query
              </button>
            </div>

            {/* Paraphrase disclaimer — set by the API to signal that the
                dialogue is a reconstructed synthesis, not verbatim quotes. */}
            {disclaimer && (
              <div className="mb-4 flex items-start gap-3 px-4 py-3 border border-[var(--gold-rule)] bg-[var(--gold-soft)]">
                <span className="font-mono text-[10px] tracking-widest uppercase text-[var(--gold-bright)] mt-0.5">
                  ⓘ Note
                </span>
                <span className="font-display italic text-sm text-[var(--ink-dim)] leading-snug">
                  {disclaimer}
                  {streaming && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-[var(--gold)]">
                      · streaming<span className="anim-cursor">▊</span>
                    </span>
                  )}
                </span>
              </div>
            )}

            <article className="p-6 sm:p-10 border border-[var(--border-gold)] bg-[var(--bg-card)] relative">
              <div className="absolute top-0 left-0 w-full rule-gold" />
              <div
                className="report-content drop-cap"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }}
              />
              <div className="absolute bottom-0 left-0 w-full rule-gold" />
            </article>

            {meta.segmentsFound !== undefined && (
              <div className="mt-5 flex items-center justify-between font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase">
                <span>
                  Sourced from {meta.segmentsFound} segments
                  {meta.searchMode === "semantic" && (
                    <span className="text-[var(--gold)] ml-2">· semantic</span>
                  )}
                </span>
                <span>Archive: {meta.totalEntries?.toLocaleString()} entries</span>
              </div>
            )}

            {/* ─── Per-stage latency (mono, subtle) ────────────── */}
            {timing && (
              <div className="mt-2 font-mono text-[10px] text-[var(--ink-mute)] tracking-wider">
                Synthesis: {(timing.synthesisMs / 1000).toFixed(1)}s · Retrieval: {(timing.retrieveMs / 1000).toFixed(1)}s · Rerank: {(timing.rerankMs / 1000).toFixed(1)}s · Total: {(timing.totalMs / 1000).toFixed(1)}s
              </div>
            )}

            {/* ─── FACT-CHECK badge (post-gen claim verifier) ──────
                Renders only when the API response includes a
                `verification` block. Older cached responses without
                the verifier output hide this silently. When hedges
                were applied to ungrounded claims we shift the border
                to amber and append a short explainer line. */}
            {verification && (
              <div
                className={`mt-6 border bg-[var(--bg-card)] p-4 ${
                  verification.hedgesApplied
                    ? "border-amber-500/60"
                    : "border-[var(--gold-rule)]"
                }`}
              >
                <div
                  className={`eyebrow ${
                    verification.hedgesApplied ? "text-amber-400" : ""
                  }`}
                >
                  § Fact-check
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-wider uppercase">
                  <span
                    className="text-[var(--ink)] cursor-help"
                    title="GROUNDED — Appears verbatim or near-verbatim in cited segments"
                  >
                    <span className="text-emerald-400">✓</span>{" "}
                    {verification.claimsGrounded} grounded
                  </span>
                  <span className="text-[var(--ink-mute)]">·</span>
                  <span
                    className="text-[var(--ink)] cursor-help"
                    title="INFERRED — Reasonable paraphrase of citation content"
                  >
                    <span className="text-[var(--gold)]">◐</span>{" "}
                    {verification.claimsInferred} inferred
                  </span>
                  <span className="text-[var(--ink-mute)]">·</span>
                  <span
                    className="text-[var(--ink)] cursor-help"
                    title="UNGROUNDED — Not found in citations — softened to hedge in final output"
                  >
                    <span
                      className={
                        verification.claimsUngrounded > 0
                          ? "text-amber-400"
                          : "text-[var(--ink-mute)]"
                      }
                    >
                      ⊗
                    </span>{" "}
                    {verification.claimsUngrounded} ungrounded
                  </span>
                </div>
                <div className="mt-2 font-mono text-[10px] tracking-wider uppercase text-[var(--ink-mute)]">
                  Hedges applied:{" "}
                  <span
                    className={
                      verification.hedgesApplied
                        ? "text-amber-400"
                        : "text-[var(--ink)]"
                    }
                  >
                    {verification.hedgesApplied ? "Yes" : "No"}
                  </span>
                  {" · "}Verification: {verification.verificationMs}ms
                  {" · "}
                  {verification.claimsTotal} claim
                  {verification.claimsTotal === 1 ? "" : "s"} checked
                </div>
                {verification.hedgesApplied && (
                  <div className="mt-3 text-sm text-[var(--ink-dim)] leading-relaxed italic">
                    Some specific claims were softened to match what the
                    transcripts directly support.
                  </div>
                )}
              </div>
            )}

            {/* ─── Why did you get this answer? ─────────────────── */}
            {citations.length > 0 && (
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setShowRetrievalExplain((v) => !v)}
                  className="font-mono text-[10px] tracking-wider uppercase text-[var(--gold)] hover:text-[var(--gold-bright)] cursor-pointer"
                >
                  {showRetrievalExplain ? "▼" : "▶"} Why did you get this answer?
                </button>
                {showRetrievalExplain && (() => {
                  const dates = citations
                    .map((c) => c.date)
                    .filter((d): d is string => !!d)
                    .sort();
                  const oldest = dates[0];
                  const newest = dates[dates.length - 1];
                  const fmt = (d: string) => {
                    const dt = new Date(d);
                    return dt.toLocaleString("en-US", { month: "short", year: "numeric" });
                  };
                  const episodeIds = new Set(citations.map((c) => c.videoId));
                  const focusLabel = speaker ? speakerDisplayName(speaker) : "all besties";
                  const modeLabel =
                    meta.searchMode === "semantic"
                      ? "semantic dense vectors"
                      : meta.searchMode === "hybrid"
                      ? "hybrid dense+sparse search"
                      : meta.searchMode === "hybrid-strict"
                      ? "hybrid dense+sparse search (single bestie)"
                      : meta.searchMode === "tfidf-degraded"
                      ? "TF-IDF keyword search only — semantic retrieval unavailable"
                      : meta.searchMode === "tfidf"
                      ? "TF-IDF keyword search"
                      : meta.searchMode || "hybrid search";
                  return (
                    <div className="mt-2 p-4 border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--ink-mute)] leading-relaxed">
                      Retrieved <span className="text-[var(--ink)]">{citations.length} transcript segments</span> across{" "}
                      <span className="text-[var(--ink)]">{episodeIds.size} episodes</span>
                      {oldest && newest && oldest !== newest && (
                        <> (<span className="text-[var(--ink)]">{fmt(oldest)} – {fmt(newest)}</span>)</>
                      )}
                      {oldest && newest && oldest === newest && (
                        <> (<span className="text-[var(--ink)]">{fmt(oldest)}</span>)</>
                      )}
                      {" "}using {modeLabel}, filtered to <span className="text-[var(--ink)]">{focusLabel}</span>
                      {meta.strictMode && (
                        <> with strict-speaker filtering</>
                      )}
                      . Results are MMR-diversified to avoid same-episode duplicates, then re-ranked by an LLM cross-encoder to surface segments that actually answer the question (not just match keywords).
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ─── Rating widget ─────────────────────────────── */}
            <div className="mt-8 border border-[var(--border)] bg-[var(--bg-card)] p-5 flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="eyebrow">§ Rate this answer</div>
                <div className="font-display italic text-base mt-1 text-[var(--ink)]">
                  {ratingSubmitted
                    ? `Thank you — you rated this ${userRating}/5`
                    : "How useful was this roundtable?"}
                </div>
              </div>
              <div
                className="flex items-center gap-1"
                onMouseLeave={() => setRatingHover(null)}
              >
                {[1, 2, 3, 4, 5].map((n) => {
                  const active = (ratingHover ?? userRating ?? 0) >= n;
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={ratingSubmitted}
                      aria-label={`Rate ${n} out of 5`}
                      onMouseEnter={() => !ratingSubmitted && setRatingHover(n)}
                      onClick={() => submitRating(n)}
                      className={`text-3xl leading-none transition-transform ${
                        ratingSubmitted
                          ? "cursor-default"
                          : "hover:scale-110 cursor-pointer"
                      }`}
                      style={{
                        color: active ? "var(--gold-bright)" : "var(--border)",
                      }}
                    >
                      ★
                    </button>
                  );
                })}
                {engagement && engagement.ratings.count > 0 && (
                  <span className="ml-3 font-mono text-[10px] tracking-wider uppercase text-[var(--ink-mute)]">
                    {engagement.ratings.avg.toFixed(1)}/5 · {engagement.ratings.count} rating
                    {engagement.ratings.count === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>

            {/* ─── Citations ─────────────────────────────────── */}
            {citations.length > 0 && (
              <div className="mt-12">
                <div className="rule-gold mb-6" />
                <div className="flex items-baseline justify-between mb-5">
                  <div>
                    <div className="eyebrow">§ Citations</div>
                    <div className="font-display italic text-xl mt-1 text-[var(--ink)]">
                      Archival evidence
                    </div>
                  </div>
                  <div className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)]">
                    {citations.length} sources
                  </div>
                </div>

                <div className="grid gap-3">
                  {citations.map((c) => (
                    <a
                      key={c.n}
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group block border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--gold-rule)] hover:bg-[var(--bg-elev)] transition-all duration-300 p-5 relative"
                    >
                      {/* Citation number */}
                      <div className="absolute top-5 left-5 font-display text-3xl text-[var(--gold)] leading-none">
                        [{c.n}]
                      </div>

                      <div className="ml-14">
                        {/* Metadata row — every field is conditional so a
                            partially-missing citation degrades gracefully:
                            unknown date / speaker / topic chips are hidden
                            rather than rendering "?" placeholders. */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 font-mono text-[10px] tracking-wider uppercase text-[var(--ink-mute)]">
                          {c.date && !Number.isNaN(new Date(c.date).getTime()) ? (
                            <span className="text-[var(--gold-bright)]">
                              {new Date(c.date).toLocaleDateString("en-US", {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          ) : null}
                          {c.time && c.time !== "?" && (
                            <span className="text-[var(--gold)]">{c.time}</span>
                          )}
                          {(() => {
                            const validSpeakers = (c.speakers || [])
                              .filter((s) => typeof s === "string" && s.trim() && s !== "?")
                              .slice(0, 4);
                            if (validSpeakers.length === 0) return null;
                            return (
                              <>
                                <span>·</span>
                                <span>
                                  voices:{" "}
                                  {validSpeakers.map((s, i) => (
                                    <span key={s} className="text-[var(--ink-dim)]">
                                      {i > 0 && ", "}
                                      {speakerDisplayName(s)}
                                    </span>
                                  ))}
                                </span>
                              </>
                            );
                          })()}
                          {(() => {
                            const validTopics = (c.topics || [])
                              .filter((t) => typeof t === "string" && t.trim())
                              .slice(0, 3);
                            if (validTopics.length === 0) return null;
                            return (
                              <>
                                <span>·</span>
                                <span>{validTopics.join(" / ")}</span>
                              </>
                            );
                          })()}
                          {c.relevance > 0 && (
                            <>
                              <span>·</span>
                              <span className="text-[var(--gold)]">
                                {Math.round(c.relevance * 100)}% match
                              </span>
                            </>
                          )}
                          {!c.videoId && (
                            <>
                              <span>·</span>
                              <span className="text-[var(--ink-mute)] italic">
                                Episode unknown
                              </span>
                            </>
                          )}
                        </div>

                        {/* Quote — only render if we have a non-empty quote */}
                        {c.quote && c.quote.trim() ? (
                          <blockquote className="font-display italic text-[var(--ink)] leading-relaxed text-[15px] border-l-2 border-[var(--gold-rule)] pl-4">
                            &ldquo;{c.quote}{c.quote.length >= 395 ? "…" : ""}&rdquo;
                          </blockquote>
                        ) : (
                          <div className="font-display italic text-[var(--ink-mute)] text-[13px] border-l-2 border-[var(--border)] pl-4">
                            Segment text unavailable
                          </div>
                        )}

                        {/* Watch link — only when we have a usable URL */}
                        {c.url && (
                          <div className="mt-3 font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] group-hover:text-[var(--gold)] transition">
                            ↳ Watch on YouTube →
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--border)] mt-auto">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="rule-gold mb-8" />
          <div className="grid sm:grid-cols-3 gap-8 items-start">
            <div>
              <div className="eyebrow mb-3">§ Powered By</div>
              <div className="flex flex-col gap-2.5 text-sm">
                <a
                  href="https://github.com/ruvnet/ruvector"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 text-[var(--ink)] hover:text-[var(--gold-bright)] transition"
                >
                  <span className="font-display italic text-base">RuVector</span>
                  <span className="font-mono text-[10px] text-[var(--ink-mute)] group-hover:text-[var(--gold)]">
                    · vector intelligence
                  </span>
                  <span className="text-[var(--gold)]">→</span>
                </a>
                <a
                  href="https://cognitumone.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 text-[var(--ink)] hover:text-[var(--gold-bright)] transition"
                >
                  <span className="font-display italic text-base">Cognitum One</span>
                  <span className="font-mono text-[10px] text-[var(--ink-mute)] group-hover:text-[var(--gold)]">
                    · hardware partner
                  </span>
                  <span className="text-[var(--gold)]">→</span>
                </a>
                <div className="font-mono text-[10px] text-[var(--ink-mute)] tracking-widest uppercase mt-1">
                  Synthesis: <span className="text-[var(--ink-dim)]">Claude</span>
                </div>
              </div>
            </div>

            <div>
              <div className="eyebrow mb-3">§ Archive</div>
              <div className="flex flex-col gap-1 font-mono text-[11px] text-[var(--ink-dim)] tracking-wider">
                <div>
                  <span className="text-[var(--gold)]">{freshness?.episodeCount || 186}</span>{" "}
                  EPISODES
                </div>
                <div>
                  <span className="text-[var(--gold)]">15,560</span> ENTRIES
                </div>
                <div>
                  <span className="text-[var(--gold)]">5.8M</span> WORDS
                </div>
                <div>
                  <span className="text-[var(--gold)]">19</span> VOICES
                </div>
                <div>
                  <span className="text-[var(--gold)]">
                    {freshness?.chapterCount?.toLocaleString() || "1,288"}
                  </span>{" "}
                  TOPICS
                </div>
              </div>
            </div>

            <div>
              <div className="eyebrow mb-3">§ Rights & Credit</div>
              <div className="text-[12px] text-[var(--ink-dim)] leading-relaxed font-display italic">
                All podcast content, the &ldquo;All-In&rdquo; name and episode material
                remain the copyright of the All-In Podcast and its creators (Chamath
                Palihapitiya, David Sacks, David Friedberg, Jason Calacanis).
                <br /><br />
                This is an independent research tool that surfaces publicly-available
                material to make it more searchable. Not affiliated with the All-In
                Podcast.
              </div>
              <div className="mt-4 font-mono text-[10px] text-[var(--ink-mute)] tracking-widest uppercase">
                Built by{" "}
                <a
                  href="https://isovision.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--gold)] hover:text-[var(--gold-bright)] transition"
                >
                  IsoVision AI →
                </a>
              </div>
            </div>
          </div>

          {/* Photo attributions — required by CC BY-SA 4.0 */}
          <div className="mt-8 pt-6 border-t border-[var(--border)] space-y-3">
            <div className="font-mono text-[10px] text-[var(--ink-mute)] tracking-widest uppercase">
              § Photo Credits
            </div>
            <div className="text-[11px] text-[var(--ink-dim)] leading-relaxed font-display italic">
              Bestie photographs sourced from{" "}
              <a
                href="https://commons.wikimedia.org"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--gold)] hover:text-[var(--gold-bright)]"
              >
                Wikimedia Commons
              </a>
              :{" "}
              <a
                href="https://commons.wikimedia.org/wiki/File:Chamath_Palihapitiya_in_2025.jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--gold)]"
              >
                Chamath (Cmichel67, CC BY-SA 4.0)
              </a>
              {" · "}
              <a
                href="https://commons.wikimedia.org/wiki/File:David_Sacks_in_March_2025.jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--gold)]"
              >
                Sacks (The White House, Public Domain)
              </a>
              {" · "}
              <a
                href="https://commons.wikimedia.org/wiki/File:David_Albert_Friedberg.jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--gold)]"
              >
                Friedberg (The Production Board, CC BY-SA 4.0)
              </a>
              {" · "}
              <a
                href="https://commons.wikimedia.org/wiki/File:Jason_Calacanis_at_LAUNCH_Festival_2016_(cropped).jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--gold)]"
              >
                Calacanis (Preshdineshkumar, CC BY-SA 4.0)
              </a>
              .
            </div>
          </div>

          {(engagement || budget) && (
            <div className="mt-6 pt-4 border-t border-[var(--border)] flex items-center justify-center gap-4 font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase flex-wrap">
              {engagement && (
                <span>
                  <span className="text-[var(--gold)]">◉</span>{" "}
                  {(engagement.visitors + VISITOR_OFFSET).toLocaleString()} visitors
                </span>
              )}
              {engagement && engagement.ratings.count > 0 && (
                <>
                  <span className="text-[var(--ink-faint)]">·</span>
                  <span>
                    <span className="text-[var(--gold-bright)]">★</span>{" "}
                    {engagement.ratings.avg.toFixed(1)}/5 from{" "}
                    {engagement.ratings.count} rating
                    {engagement.ratings.count === 1 ? "" : "s"}
                  </span>
                </>
              )}
              {budget && (
                <>
                  <span className="text-[var(--ink-faint)]">·</span>
                  <span>
                    <span className="text-[var(--gold)]">◆</span>{" "}
                    {budget.remaining}/{budget.limit} queries left today
                  </span>
                </>
              )}
            </div>
          )}

          {/* Fair-use copyright notice — surfaced when the API returns one
              after a successful synthesis. Subtle, mono, intentionally small. */}
          {copyright && (
            <div className="mt-6 pt-4 border-t border-[var(--border)] font-mono text-[10px] text-[var(--ink-faint)] tracking-wide leading-relaxed">
              {copyright}
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-[var(--border)] flex items-center justify-between font-mono text-[10px] text-[var(--ink-faint)] tracking-widest uppercase flex-wrap gap-2">
            <div>Ask the All-In Experts · Vol. I · MMXXVI</div>
            <div className="flex items-center gap-4">
              <Link
                href="/legal"
                className="text-[var(--ink-mute)] hover:text-[var(--gold)] transition"
              >
                Takedown / Legal →
              </Link>
              <span>© {new Date().getFullYear()} IsoVision AI</span>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
