"use client";

import { useState, useRef, useEffect } from "react";

const SPEAKERS = [
  { key: "all", label: "All Besties", color: "#60a5fa", icon: "🎙️" },
  { key: "chamath", label: "Chamath", color: "#f59e0b", icon: "💰" },
  { key: "sacks", label: "Sacks", color: "#3b82f6", icon: "🏛️" },
  { key: "friedberg", label: "Friedberg", color: "#10b981", icon: "🔬" },
  { key: "calacanis", label: "Jason", color: "#ef4444", icon: "🚀" },
];

const MODES = [
  { key: "analysis", label: "Analysis" },
  { key: "forecast", label: "Forecast" },
];

const EXAMPLE_QUERIES = [
  "Should the US regulate AI companies?",
  "Will Bitcoin hit 200K?",
  "Is a recession coming in 2026?",
  "What's the future of nuclear energy?",
  "Should we be worried about China's AI progress?",
  "Are tariffs good for the economy?",
];

/**
 * Render markdown to HTML.
 * SAFETY: Content originates exclusively from our Anthropic API response
 * (server-side, no user HTML input) — XSS risk is minimal.
 */
function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^---$/gm, '<hr />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(https:\/\/youtube\.com\/watch\?[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>');
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [speaker, setSpeaker] = useState("all");
  const [mode, setMode] = useState("analysis");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState("");
  const [meta, setMeta] = useState<{ segmentsFound?: number; totalEntries?: number }>({});
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (report && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [report]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setError("");
    setReport("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.trim(),
          speaker: speaker === "all" ? null : speaker,
          mode,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }

      setReport(data.report);
      setMeta({ segmentsFound: data.segmentsFound, totalEntries: data.totalEntries });
    } catch {
      setError("Failed to connect. Is the server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex-1 flex flex-col">
      <header className="border-b border-[#2a2a2a] px-4 py-6 sm:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Ask the All-In Experts
          </h1>
          <p className="mt-2 text-[#888] text-sm sm:text-base">
            Intelligence from 450+ episodes of the All-In Podcast
          </p>
        </div>
      </header>

      <div className="flex-1 px-4 py-6 sm:px-8">
        <div className="max-w-3xl mx-auto space-y-6">

          <div className="flex flex-wrap gap-2 justify-center">
            {SPEAKERS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSpeaker(s.key)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                  speaker === s.key
                    ? "text-white shadow-lg"
                    : "bg-[#1a1a1a] text-[#888] hover:text-white hover:bg-[#252525]"
                }`}
                style={speaker === s.key ? { backgroundColor: s.color } : {}}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2 justify-center">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`px-4 py-1.5 rounded-lg text-sm transition-all ${
                  mode === m.key
                    ? "bg-[#252525] text-white border border-[#3a3a3a]"
                    : "text-[#666] hover:text-[#999]"
                }`}
              >
                {m.key === "forecast" ? "🔮 " : "🧠 "}{m.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={mode === "forecast"
                ? "What do you want the besties to predict?"
                : "What would the besties think about..."}
              className="w-full px-5 py-4 rounded-xl bg-[#151515] border border-[#2a2a2a] text-white text-base sm:text-lg placeholder-[#555] focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6] transition-all"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Thinking
                </span>
              ) : "Ask"}
            </button>
          </form>

          {!report && !loading && (
            <div className="space-y-3">
              <p className="text-[#555] text-xs text-center uppercase tracking-wider">Try asking</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {EXAMPLE_QUERIES.map((eq) => (
                  <button
                    key={eq}
                    onClick={() => { setQuery(eq); inputRef.current?.focus(); }}
                    className="px-3 py-1.5 rounded-lg bg-[#151515] border border-[#222] text-[#888] text-sm hover:text-white hover:border-[#3a3a3a] transition-all"
                  >
                    {eq}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="text-center py-12 space-y-4">
              <div className="flex justify-center gap-3">
                {SPEAKERS.slice(1).map((s, i) => (
                  <div
                    key={s.key}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-xl animate-bounce"
                    style={{ backgroundColor: s.color + "22", animationDelay: `${i * 150}ms` }}
                  >
                    {s.icon}
                  </div>
                ))}
              </div>
              <p className="text-[#888] text-sm">The besties are deliberating...</p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
              {error}
            </div>
          )}

          {report && (
            <div ref={reportRef} className="space-y-4">
              <div className="p-6 rounded-xl bg-[#151515] border border-[#2a2a2a]">
                {/* Content from our own Anthropic API — not user-supplied HTML */}
                <div
                  className="report-content"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }}
                />
              </div>

              {meta.segmentsFound !== undefined && (
                <p className="text-center text-[#555] text-xs">
                  Analyzed {meta.segmentsFound} segments from {meta.totalEntries?.toLocaleString()} knowledge entries across 450+ All-In episodes
                </p>
              )}
            </div>
          )}

          {!report && !loading && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-8">
              {SPEAKERS.slice(1).map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSpeaker(s.key)}
                  className={`p-4 rounded-xl border transition-all text-center ${
                    speaker === s.key
                      ? "border-[#3a3a3a] bg-[#1a1a1a]"
                      : "border-[#222] bg-[#111] hover:border-[#333]"
                  }`}
                >
                  <div className="text-2xl mb-1">{s.icon}</div>
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="text-[#666] text-xs mt-0.5">
                    {s.key === "chamath" && "Markets & VC"}
                    {s.key === "sacks" && "Policy & SaaS"}
                    {s.key === "friedberg" && "Science & Bio"}
                    {s.key === "calacanis" && "Startups & Media"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-[#1a1a1a] px-4 py-4 text-center">
        <p className="text-[#444] text-xs">
          Powered by RuVector + Claude | 5.8M words from 450+ All-In episodes
        </p>
      </footer>
    </main>
  );
}
