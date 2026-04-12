import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const DATA_DIR = join(process.cwd(), 'public', 'data');

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

interface ChapterLookup {
  [id: string]: {
    topic: string;
    episodeTitle: string;
    episodeDate: string;
    audioUrl: string;
    startTime: string;
    startSec: number;
  };
}

let chaptersCache: Episode[] | null = null;
let lookupCache: ChapterLookup | null = null;
let freshnessCache: object | null = null;

function loadChapters(): Episode[] {
  if (chaptersCache) return chaptersCache;
  const path = join(DATA_DIR, 'chapters.json');
  if (!existsSync(path)) throw new Error('Chapters index not found');
  chaptersCache = JSON.parse(readFileSync(path, 'utf8'));
  return chaptersCache!;
}

function loadLookup(): ChapterLookup {
  if (lookupCache) return lookupCache;
  const path = join(DATA_DIR, 'chapter-lookup.json');
  if (!existsSync(path)) throw new Error('Chapter lookup not found');
  lookupCache = JSON.parse(readFileSync(path, 'utf8'));
  return lookupCache!;
}

function loadFreshness() {
  if (freshnessCache) return freshnessCache;
  const path = join(DATA_DIR, 'freshness.json');
  if (!existsSync(path)) return null;
  freshnessCache = JSON.parse(readFileSync(path, 'utf8'));
  return freshnessCache;
}

function parseYouTubeId(description: string): string | null {
  const match = description.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q');
    const episodeId = url.searchParams.get('episode');
    const weeks = parseInt(url.searchParams.get('weeks') || '0');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const freshness = loadFreshness();

    // ─── Episode detail view ──────────────────────────────
    if (episodeId) {
      const episodes = loadChapters();
      const ep = episodes.find((e) => e.id === episodeId);
      if (!ep) {
        return NextResponse.json({ error: 'Episode not found' }, { status: 404 });
      }
      return NextResponse.json({ episode: ep, freshness });
    }

    // ─── Topic search across all chapters ────────────────
    if (query && query.trim()) {
      const lookup = loadLookup();
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

      const scored: Array<{ id: string; score: number; data: ChapterLookup[string] }> = [];
      for (const [id, data] of Object.entries(lookup)) {
        const topicLower = data.topic.toLowerCase();
        let score = 0;
        for (const w of queryWords) {
          if (topicLower.includes(w)) score += 1;
        }
        if (score > 0) {
          scored.push({ id, score, data });
        }
      }

      scored.sort((a, b) => b.score - a.score || new Date(b.data.episodeDate).getTime() - new Date(a.data.episodeDate).getTime());
      const results = scored.slice(0, limit).map((s) => ({
        id: s.id,
        topic: s.data.topic,
        episodeTitle: s.data.episodeTitle,
        episodeDate: s.data.episodeDate,
        startTime: s.data.startTime,
        startSec: s.data.startSec,
        audioUrl: s.data.audioUrl,
      }));

      return NextResponse.json({
        query,
        resultCount: results.length,
        results,
        freshness,
      });
    }

    // ─── Episode list (optionally filtered by date range) ─
    const episodes = loadChapters();
    let filtered = episodes;

    if (weeks > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - weeks * 7);
      filtered = episodes.filter((e) => new Date(e.date) >= cutoff);
    }

    // Return lightweight episode list (no chapter details)
    const list = filtered.slice(0, limit).map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      chapterCount: e.chapterCount,
    }));

    return NextResponse.json({
      episodeCount: filtered.length,
      episodes: list,
      freshness,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('Chapters API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
