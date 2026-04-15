import { NextResponse } from 'next/server';
import { recordVisit } from '@/lib/engagement';

export const dynamic = 'force-dynamic';

/**
 * POST /api/visit — bump the visitor counter. Called once per browser
 * session by the frontend on first mount; localStorage dedupes client-side
 * so refreshes don't inflate the count.
 */
export async function POST() {
  const total = await recordVisit();
  return NextResponse.json(
    { visitors: total },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}
