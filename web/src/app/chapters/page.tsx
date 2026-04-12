"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface EpisodeListItem {
  id: string;
  title: string;
  date: string;
  chapterCount: number;
}

interface Chapter {
  id: string;
  startSec: number;
  startTime: string;
  topic: string;
}

interface Episode {
  id: string;
  title: string;
  date: string;
  audioUrl: string;
  chapterCount: number;
  chapters: Chapter[];
}

interface SearchResult {
  id: string;
  topic: string;
  episodeTitle: string;
  episodeDate: string;
  startTime: string;
  startSec: number;
  audioUrl: string;
}

interface Freshness {
  updatedAt: string;
  episodeCount: number;
  chapterCount: number;
  dateRange: { oldest: string; newest: string };
  latestEpisode: { title: string; date: string };
}

const WEEK_FILTERS = [
  { label: "Last 2 weeks", weeks: 2 },
  { label: "Last 10 weeks", weeks: 10 },
  { label: "Last 6 months", weeks: 26 },
  { label: "All time", weeks: 0 },
];

export default function ChaptersPage() {
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [totalEpisodes, setTotalEpisodes] = useState(0);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [weekFilter, setWeekFilter] = useState(10);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadEpisodes(weekFilter);
  }, [weekFilter]);

  async function loadEpisodes(weeks: number) {
    setLoading(true);
    try {
      const res = await fetch(`/api/chapters?weeks=${weeks}&limit=200`);
      const data = await res.json();
      setEpisodes(data.episodes || []);
      setTotalEpisodes(data.episodeCount || 0);
      setFreshness(data.freshness);
    } finally {
      setLoading(false);
    }
  }

  async function openEpisode(id: string) {
    setDetailLoading(true);
    setSelectedEpisode(null);
    try {
      const res = await fetch(`/api/chapters?episode=${id}`);
      const data = await res.json();
      setSelectedEpisode(data.episode);
      setTimeout(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    } finally {
      setDetailLoading(false);
    }
  }

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const res = await fetch(`/api/chapters?q=${encodeURIComponent(searchQuery.trim())}&limit=40`);
    const data = await res.json();
    setSearchResults(data.results || []);
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchResults([]);
    searchRef.current?.focus();
  }

  const freshnessDate = freshness?.updatedAt
    ? new Date(freshness.updatedAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const latestDate = freshness?.latestEpisode?.date
    ? new Date(freshness.latestEpisode.date).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "";

  return (
    <main className="flex-1 flex flex-col min-h-screen">
      {/* Header */}
      <header className="border-b border-[var(--border)]">
        <div className="max-w-5xl mx-auto px-6 pt-10 pb-8">
          <div className="flex items-baseline justify-between flex-wrap gap-3">
            <Link
              href="/"
              className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition"
            >
              ← Back to Ask
            </Link>
            <div className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)]">
              № 02 · Episode Ledger
            </div>
          </div>

          <h1 className="font-display text-5xl sm:text-6xl leading-[0.95] mt-5 tracking-tight">
            The <span className="font-display-italic text-[var(--gold-bright)]">Archive</span>
          </h1>
          <p className="mt-4 text-[var(--ink-dim)] text-base max-w-2xl">
            Every episode, every topic. Ground-truth chapter data straight from the
            podcast show notes —{" "}
            <span className="text-[var(--gold)] font-mono text-sm tracking-wider">
              {freshness?.chapterCount?.toLocaleString() || "..."} TOPICS
            </span>{" "}
            across{" "}
            <span className="text-[var(--gold)] font-mono text-sm tracking-wider">
              {freshness?.episodeCount || "..."} EPISODES
            </span>
            .
          </p>

          {/* Freshness badge */}
          {freshness && (
            <div className="mt-5 inline-flex items-center gap-3 px-4 py-2 border border-[var(--border-gold)] bg-[var(--gold-soft)]">
              <span className="w-2 h-2 rounded-full bg-[var(--gold)] anim-shimmer"></span>
              <div className="font-mono text-[10px] tracking-widest uppercase">
                <span className="text-[var(--gold-bright)]">Current as of</span>{" "}
                <span className="text-[var(--ink)]">{freshnessDate}</span>
                <span className="text-[var(--ink-mute)]"> · Last episode: </span>
                <span className="text-[var(--ink)]">{latestDate}</span>
              </div>
            </div>
          )}

          <div className="rule-gold mt-8" />
        </div>
      </header>

      <div className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full">
        {/* Search */}
        <section className="mb-10">
          <div className="eyebrow mb-5">§ Search topics across every episode</div>
          <form onSubmit={runSearch} className="relative">
            <div className="relative border border-[var(--border-strong)] bg-[var(--bg-card)] focus-within:border-[var(--gold)] transition">
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g. debt crisis, OpenAI, tariffs, DOGE, nuclear energy…"
                className="w-full px-5 py-4 pr-32 bg-transparent outline-none font-display italic text-lg text-[var(--ink)] placeholder:text-[var(--ink-mute)]"
              />
              <button
                type="submit"
                className="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 bg-[var(--gold)] hover:bg-[var(--gold-bright)] text-[var(--bg)] font-mono text-[10px] tracking-widest uppercase font-semibold"
              >
                Search →
              </button>
            </div>
          </form>

          {searchResults.length > 0 && (
            <div className="mt-5">
              <div className="flex items-baseline justify-between mb-3">
                <div className="eyebrow">
                  § Found {searchResults.length} topics across episodes
                </div>
                <button
                  onClick={clearSearch}
                  className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)]"
                >
                  Clear ✕
                </button>
              </div>
              <div className="space-y-2">
                {searchResults.map((r) => (
                  <a
                    key={r.id}
                    href={`${r.audioUrl}#t=${r.startSec}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--gold-rule)] p-4 transition"
                  >
                    <div className="flex items-baseline gap-4">
                      <div className="font-mono text-[10px] text-[var(--gold)] tracking-widest whitespace-nowrap">
                        {r.startTime}
                      </div>
                      <div className="flex-1">
                        <div className="font-display text-[15px] italic text-[var(--ink)] group-hover:text-[var(--gold-bright)] leading-snug">
                          {r.topic}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase">
                          {new Date(r.episodeDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}{" "}
                          · {r.episodeTitle.slice(0, 80)}
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Week filter */}
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <div className="eyebrow">§ Browse recent episodes</div>
            <div className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)]">
              {totalEpisodes} episodes
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-5">
            {WEEK_FILTERS.map((f) => (
              <button
                key={f.weeks}
                onClick={() => setWeekFilter(f.weeks)}
                className={`px-3 py-1.5 text-xs border transition-all ${
                  weekFilter === f.weeks
                    ? "border-[var(--gold)] bg-[var(--gold-soft)] text-[var(--gold-bright)]"
                    : "border-[var(--border)] bg-[var(--bg-card)] text-[var(--ink-dim)] hover:border-[var(--border-strong)] hover:text-[var(--ink)]"
                }`}
              >
                <span className="font-display italic">{f.label}</span>
              </button>
            ))}
          </div>

          {/* Episode list */}
          {loading ? (
            <div className="py-16 text-center">
              <div className="font-display italic text-[var(--ink-mute)]">
                Loading episodes<span className="anim-cursor">▊</span>
              </div>
            </div>
          ) : episodes.length === 0 ? (
            <div className="py-16 text-center font-display italic text-[var(--ink-mute)]">
              No episodes in this range.
            </div>
          ) : (
            <div className="space-y-2">
              {episodes.map((ep, i) => (
                <button
                  key={ep.id}
                  onClick={() => openEpisode(ep.id)}
                  className={`group w-full text-left border transition-all duration-300 p-4 ${
                    selectedEpisode?.id === ep.id
                      ? "border-[var(--gold)] bg-[var(--gold-soft)]"
                      : "border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--gold-rule)]"
                  }`}
                >
                  <div className="flex items-baseline gap-4">
                    <div className="font-mono text-[10px] text-[var(--gold)] tracking-widest whitespace-nowrap w-16">
                      №{(i + 1).toString().padStart(3, "0")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-display text-[16px] text-[var(--ink)] group-hover:text-[var(--gold-bright)] leading-snug">
                        {ep.title}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase">
                        {new Date(ep.date).toLocaleDateString("en-US", {
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        })}{" "}
                        · {ep.chapterCount} topics
                      </div>
                    </div>
                    <div className="font-display text-xl text-[var(--gold)] group-hover:translate-x-1 transition-transform">
                      →
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Episode detail */}
        {detailLoading && (
          <section className="py-12 text-center">
            <div className="font-display italic text-[var(--ink-mute)]">
              Loading topic breakdown<span className="anim-cursor">▊</span>
            </div>
          </section>
        )}

        {selectedEpisode && (
          <section ref={detailRef} className="mb-10 anim-fade-up">
            <div className="rule-gold-double mb-6" />
            <div className="flex items-baseline justify-between mb-5">
              <div>
                <div className="eyebrow">§ Topic breakdown</div>
                <div className="font-display italic text-2xl mt-1 text-[var(--ink)] leading-tight max-w-3xl">
                  {selectedEpisode.title}
                </div>
                <div className="mt-2 font-mono text-[10px] text-[var(--ink-mute)] tracking-wider uppercase">
                  {new Date(selectedEpisode.date).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}{" "}
                  · {selectedEpisode.chapterCount} topics
                </div>
              </div>
              <button
                onClick={() => setSelectedEpisode(null)}
                className="font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] border border-[var(--border)] px-3 py-1.5"
              >
                Close ✕
              </button>
            </div>

            <article className="border border-[var(--border-gold)] bg-[var(--bg-card)] p-6 sm:p-10 relative">
              <div className="absolute top-0 left-0 right-0 rule-gold" />
              <div className="space-y-5">
                {selectedEpisode.chapters.map((ch, i) => (
                  <div key={ch.id} className="flex items-start gap-4 group">
                    <div className="font-display text-3xl text-[var(--gold)] leading-none w-14 shrink-0">
                      {(i + 1).toString().padStart(2, "0")}
                    </div>
                    <div className="flex-1 pt-1">
                      <div className="font-mono text-[10px] text-[var(--gold)] tracking-widest mb-1">
                        {ch.startTime}
                      </div>
                      <div className="font-display text-lg text-[var(--ink)] leading-snug">
                        {ch.topic}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="absolute bottom-0 left-0 right-0 rule-gold" />
            </article>

            {selectedEpisode.audioUrl && (
              <div className="mt-5">
                <a
                  href={selectedEpisode.audioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase text-[var(--ink-mute)] hover:text-[var(--gold)] transition"
                >
                  ↳ Listen to episode →
                </a>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
