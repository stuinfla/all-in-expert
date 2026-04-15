import { NextRequest, NextResponse } from 'next/server';
import { recordRating } from '@/lib/engagement';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rate { stars: 1..5 } — record a user rating.
 * Returns the new count + average. Frontend dedupes per-browser via
 * localStorage so a single visitor can only rate once.
 */
export async function POST(req: NextRequest) {
  try {
    const { stars } = (await req.json()) as { stars?: number };
    if (typeof stars !== 'number' || stars < 1 || stars > 5) {
      return NextResponse.json(
        { error: 'stars must be a number between 1 and 5' },
        { status: 400 }
      );
    }
    const result = await recordRating(stars);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
