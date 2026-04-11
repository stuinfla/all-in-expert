import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Content index is bundled in public/data/ — ships with Vercel deployment
const DATA_DIR = join(process.cwd(), 'public', 'data');

// Lazy-loaded content index (cached in memory after first request)
let contentIndex: Record<string, ContentEntry> | null = null;

interface ContentEntry {
  c: string;   // text content
  v: string;   // video ID
  t: string;   // timestamp
  s: number;   // start ms
  p: string[]; // topics
  m: string[]; // speakers mentioned
  u: string;   // youtube URL
}

const SPEAKER_CONTEXT: Record<string, { name: string; short: string; lens: string; style: string }> = {
  chamath: {
    name: 'Chamath Palihapitiya',
    short: 'Chamath',
    lens: 'Venture capitalist (Social Capital). Analyzes via capital allocation, market efficiency, systemic risk. Contrarian macro views.',
    style: 'Bold, contrarian, numbers-heavy. Takes unpopular positions backed by data.'
  },
  sacks: {
    name: 'David Sacks',
    short: 'Sacks',
    lens: 'Enterprise SaaS investor (Craft Ventures), former PayPal COO. From Jan 2025: White House AI & Crypto Czar. Pro-business, non-interventionist foreign policy.',
    style: 'Analytical, measured, builds logical arguments. Frames issues as systems problems.'
  },
  friedberg: {
    name: 'David Friedberg',
    short: 'Friedberg',
    lens: 'CEO of The Production Board. Deep science background (former Google). "Sultan of Science." First-principles thinker on climate, biotech, food, energy.',
    style: 'Methodical, science-first. Reframes political debates as scientific/economic questions.'
  },
  calacanis: {
    name: 'Jason Calacanis',
    short: 'Jason',
    lens: 'Angel investor, LAUNCH CEO, podcast host/moderator. Startup ecosystem insider and media operator.',
    style: "Provocative, asks uncomfortable questions, plays devil's advocate. Steers toward actionable takeaways."
  }
};

function loadContentIndex(): Record<string, ContentEntry> {
  if (contentIndex) return contentIndex;

  const indexPath = join(DATA_DIR, 'content-index.json');
  if (!existsSync(indexPath)) {
    throw new Error('Content index not found. Run: bash scripts/refresh-kb.sh');
  }

  contentIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  return contentIndex!;
}

function keywordSearch(index: Record<string, ContentEntry>, query: string, limit = 20) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const stopWords = new Set(['what', 'would', 'will', 'about', 'think', 'they', 'this',
    'that', 'from', 'have', 'been', 'should', 'could', 'does', 'with', 'going', 'their']);
  const searchTerms = queryWords.filter(w => !stopWords.has(w));

  const results: Array<{ id: string; entry: ContentEntry; score: number }> = [];

  for (const [id, entry] of Object.entries(index)) {
    const content = entry.c.toLowerCase();
    let score = 0;
    for (const term of searchTerms) {
      const regex = new RegExp(`\\b${term}`, 'g');
      const matches = content.match(regex);
      if (matches) score += matches.length;
    }
    if (score > 0) results.push({ id, entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { query, speaker, mode } = await req.json();

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const index = loadContentIndex();
    const totalEntries = Object.keys(index).length;

    if (totalEntries === 0) {
      return NextResponse.json({ error: 'Knowledge base is empty' }, { status: 500 });
    }

    const segments = keywordSearch(index, query, 30);

    const segmentText = segments
      .slice(0, 15)
      .map((s, i) => {
        const topics = s.entry.p.join(', ');
        return `--- Segment ${i + 1} [${s.entry.t}] (Topics: ${topics}) ---\n${s.entry.c.slice(0, 600)}\n${s.entry.u}`;
      })
      .join('\n\n');

    const speakerProfiles = Object.entries(SPEAKER_CONTEXT)
      .map(([, s]) => `**${s.name} (${s.short})**: ${s.lens}\nStyle: ${s.style}`)
      .join('\n\n');

    const focusSpeaker = speaker ? SPEAKER_CONTEXT[speaker] : null;
    const isForecast = mode === 'forecast';

    const systemPrompt = `You are the All-In Expert — an intelligence system trained on 450+ episodes of the All-In Podcast (Chamath Palihapitiya, David Sacks, David Friedberg, Jason Calacanis).

Your job is to analyze transcript segments and synthesize what each "bestie" would think about a given question.

THE FOUR BESTIES:
${speakerProfiles}

RULES:
1. Base analysis on the ACTUAL transcript segments provided — cite specific moments
2. When you can identify who is speaking from context, attribute it
3. Distinguish what they HAVE said (evidence) vs what they WOULD LIKELY say (inference)
4. Be specific about reasoning style, not generic
5. Include YouTube links to relevant segments
6. Rate confidence: HIGH (direct quotes), MEDIUM (strong inference), LOW (extrapolation)
7. Format with markdown headers and bullet points for readability`;

    let userPrompt: string;

    if (focusSpeaker) {
      userPrompt = `QUESTION: "${query}"

FOCUS: What would ${focusSpeaker.name} think?

Relevant transcript segments:
${segmentText}

Provide:
1. **${focusSpeaker.short}'s Position**: Based on established views
2. **Key Evidence**: Specific segments supporting this
3. **Their Reasoning**: Using their analytical lens
4. **Confidence Level**: How certain we are
5. **Relevant Episodes**: YouTube links`;
    } else if (isForecast) {
      userPrompt = `FORECASTING QUESTION: "${query}"

Relevant transcript segments:
${segmentText}

Provide a FORECAST REPORT:
1. **Chamath's Forecast**: Prediction + reasoning (macro/capital lens)
2. **Sacks' Forecast**: Prediction + reasoning (enterprise/political lens)
3. **Friedberg's Forecast**: Prediction + reasoning (science/first-principles lens)
4. **Jason's Forecast**: Prediction + reasoning (startup/media lens)
5. **Consensus**: Where they agree/disagree
6. **Confidence**: How reliable based on track record
7. **Sources**: YouTube links`;
    } else {
      userPrompt = `QUESTION: "${query}"

Relevant transcript segments:
${segmentText}

Provide a BESTIE INTELLIGENCE REPORT:
1. **Chamath's Take**: What + why + evidence
2. **Sacks' Take**: What + why + evidence
3. **Friedberg's Take**: What + why + evidence
4. **Jason's Take**: What + why + evidence
5. **Consensus View**: Alignments and divergences
6. **Confidence**: HIGH/MEDIUM/LOW per bestie
7. **Sources**: YouTube links`;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    return NextResponse.json({
      report: text,
      segmentsFound: segments.length,
      totalEntries
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
