import { salesRunCommand } from '@/server/sales-sync/command-handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  return salesRunCommand('fail', request, context.params);
}
