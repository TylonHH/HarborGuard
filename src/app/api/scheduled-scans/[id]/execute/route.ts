import { NextRequest } from 'next/server'
import { executeScheduledScan } from '@/lib/scheduled-scans/executor'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return executeScheduledScan(id);
}
