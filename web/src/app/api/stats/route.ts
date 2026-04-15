import { NextResponse } from 'next/server';
import { getStats } from '@/lib/rate-limit';
import { getEngagement } from '@/lib/engagement';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [budget, engagement] = await Promise.all([getStats(), getEngagement()]);
  return NextResponse.json(
    { budget, engagement },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}
