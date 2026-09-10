import { randomUUID } from 'node:crypto';
import { livePath, liveResponseSchema } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createLogger, logRequest } from '@/server/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const start = performance.now();
  const requestId = randomUUID();
  const config = readServerConfig(process.env);
  const response = Response.json(liveResponseSchema.parse({ status: 'ok' }), {
    headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
  });
  logRequest(createLogger(config.LOG_LEVEL), {
    requestId, routeTemplate: livePath, method: 'GET', status: 200,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
  });
  return response;
}
