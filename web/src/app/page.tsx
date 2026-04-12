"use client";

import { useState, useRef, useEffect, useMemo } from "react";

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

const EXAMPLE_QUERIES = [
  { q: "Will the US avoid a debt crisis this decade?", mode: "forecast" },
  { q: "What would Sacks do about TikTok?", mode: "analysis" },
  { q: "Is a recession coming in 2026?", mode: "forecast" },
  { q: "Chamath on the future of nuclear energy", mode: "analysis" },
  { q: "Friedberg on longevity and healthspan", mode: "analysis" },
  { q: "Will Bitcoin hit 200K?", mode: "forecast" },
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
  "Cross-referencing 450 episodes",
  "Synthesizing positions",
  "Assembling citations",
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [mode, setMode] = useState<"analysis" | "forecast">("analysis");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [meta, setMeta] = useState<{ segmentsFound?: number; totalEntries?: number; searchMode?: string }>({});
  const [error, setError] = useState("");
  const [loadingPhrase, setLoadingPhrase] = useState(0);
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
    setError("");
    setReport("");
    setCitations([]);
    setLoadingPhrase(0);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.trim(),
          speaker,
          mode,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }

      setReport(data.report);
      setCitations(data.citations || []);
      setMeta({
        segmentsFound: data.segmentsFound,
        totalEntries: data.totalEntries,
        searchMode: data.searchMode,
      });
    } catch {
      setError("Unable to reach the archive.");
    } finally {
      setLoading(false);
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
    setError("");
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="eyebrow mb-3">№ 01 · Intelligence Dossier</div>
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
                  450+ EPISODES
                </span>{" "}
                · <span className="text-[var(--gold)] font-mono text-sm tracking-wider">5.8M WORDS</span>.
                Four minds, plus the guests that shape the conversation.
              </p>
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
            {/* ALL card */}
            <button
              onClick={() => setSpeaker(null)}
              className={`group relative p-3 sm:p-5 border text-left transition-all duration-300 ${
                !speaker
                  ? "border-[var(--gold)] bg-[var(--gold-soft)]"
                  : "border-[var(--border)] hover:border-[var(--border-strong)] bg-[var(--bg-card)]"
              }`}
            >
              <div className="font-display text-3xl sm:text-5xl leading-none text-[var(--gold-bright)]">
                ∴
              </div>
              <div className="mt-2 sm:mt-4 font-mono text-[10px] tracking-widest uppercase text-[var(--gold)]">
                The Council
              </div>
              <div className="mt-0.5 text-[11px] sm:text-xs text-[var(--ink-dim)] leading-tight hidden sm:block">
                All four
              </div>
            </button>

            {BESTIES.map((b) => {
              const selected = speaker === b.key;
              const cssVar = `var(--${b.color})`;
              const softVar = `var(--${b.color}-soft)`;
              return (
                <button
                  key={b.key}
                  onClick={() => setSpeaker(b.key)}
                  className="group relative p-3 sm:p-5 border text-left transition-all duration-300"
                  style={{
                    borderColor: selected ? cssVar : "var(--border)",
                    background: selected ? softVar : "var(--bg-card)",
                  }}
                >
                  <div
                    className="font-display text-3xl sm:text-5xl leading-none"
                    style={{ color: selected ? cssVar : "var(--ink)" }}
                  >
                    {b.initial}
                  </div>
                  <div
                    className="mt-2 sm:mt-4 font-mono text-[10px] tracking-widest uppercase"
                    style={{ color: selected ? cssVar : "var(--ink-mute)" }}
                  >
                    {b.short}
                  </div>
                  <div className="mt-0.5 text-[11px] sm:text-xs text-[var(--ink-dim)] leading-tight hidden sm:block">
                    {b.role}
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
            <div className="mt-2 flex justify-between items-center font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase">
              <span>
                {selectedBestie ? `Focus: ${selectedBestie.short}` : "All four besties"}
              </span>
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
                </div>
              </div>
              <button
                onClick={clearReport}
                className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition border border-[var(--border)] px-3 py-1.5"
              >
                New Query
              </button>
            </div>

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
                        {/* Metadata row */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 font-mono text-[10px] tracking-wider uppercase text-[var(--ink-mute)]">
                          <span className="text-[var(--gold)]">{c.time}</span>
                          {c.speakers.length > 0 && (
                            <>
                              <span>·</span>
                              <span>
                                voices:{" "}
                                {c.speakers.slice(0, 4).map((s, i) => (
                                  <span key={s} className="text-[var(--ink-dim)]">
                                    {i > 0 && ", "}
                                    {speakerDisplayName(s)}
                                  </span>
                                ))}
                              </span>
                            </>
                          )}
                          {c.topics.length > 0 && (
                            <>
                              <span>·</span>
                              <span>{c.topics.slice(0, 3).join(" / ")}</span>
                            </>
                          )}
                          {c.relevance > 0 && (
                            <>
                              <span>·</span>
                              <span className="text-[var(--gold)]">
                                {Math.round(c.relevance * 100)}% match
                              </span>
                            </>
                          )}
                        </div>

                        {/* Quote */}
                        <blockquote className="font-display italic text-[var(--ink)] leading-relaxed text-[15px] border-l-2 border-[var(--gold-rule)] pl-4">
                          &ldquo;{c.quote}{c.quote.length >= 395 ? "…" : ""}&rdquo;
                        </blockquote>

                        {/* Watch link */}
                        <div className="mt-3 font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] group-hover:text-[var(--gold)] transition">
                          ↳ Watch on YouTube →
                        </div>
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
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="rule-gold mb-6" />
          <div className="grid sm:grid-cols-3 gap-6 items-start">
            <div>
              <div className="eyebrow mb-2">§ Powered By</div>
              <div className="flex flex-col gap-2 text-sm">
                <a
                  href="https://github.com/ruvnet/ruvector"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 text-[var(--ink)] hover:text-[var(--gold-bright)] transition"
                >
                  <span className="font-display italic text-base">RuVector</span>
                  <span className="font-mono text-[10px] text-[var(--ink-mute)] group-hover:text-[var(--gold)]">
                    vector intelligence
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
                    hardware partner
                  </span>
                  <span className="text-[var(--gold)]">→</span>
                </a>
                <div className="font-mono text-[10px] text-[var(--ink-mute)] tracking-widest uppercase mt-1">
                  Synthesis: <span className="text-[var(--ink-dim)]">Claude</span>
                </div>
              </div>
            </div>

            <div>
              <div className="eyebrow mb-2">§ Archive</div>
              <div className="flex flex-col gap-1 font-mono text-[11px] text-[var(--ink-dim)] tracking-wider">
                <div>
                  <span className="text-[var(--gold)]">448</span> EPISODES
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
              </div>
            </div>

            <div className="sm:text-right">
              <div className="eyebrow mb-2">§ Disclaimer</div>
              <div className="text-[11px] text-[var(--ink-mute)] italic leading-relaxed font-display">
                Not affiliated with the All-In Podcast. An independent research
                tool for fans & forecasters.
              </div>
              <div className="font-mono text-[10px] text-[var(--ink-faint)] tracking-widest uppercase mt-3">
                MMXXVI · Vol. I
              </div>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
