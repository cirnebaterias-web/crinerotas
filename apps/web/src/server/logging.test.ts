import { expect, it } from 'vitest';
import { createLogger, logReportExport, logRequest } from './logging';

it('redacts sensitive fields and serializes structured request metadata', () => {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (line) => { lines.push(line); } });
  logger.info({ authorization: 'Bearer private', body: { gps: 'location' }, user: { password: 'password123' }, token: 'private' });
  const event = { requestId: 'test-id', routeTemplate: '/api/v1/health/live', method: 'GET', status: 200, durationMs: 1.2, unknownSecret: 'not-allowed' };
  logRequest(logger, event);
  expect(lines.join('')).not.toMatch(/Bearer private|location|password123|not-allowed/);
  expect(JSON.parse(lines[0]!)).toMatchObject({ authorization: '[REDACTED]', body: '[REDACTED]' });
  expect(JSON.parse(lines[1]!)).toMatchObject({ level: 30, requestId: 'test-id', status: 200, durationMs: 1.2 });
});

it('logs only the allowlisted export metadata', () => {
  const lines: string[] = [];
  const logger = createLogger('info', { write: (line) => { lines.push(line); } });
  logReportExport(logger, {
    requestId: 'export-id', routeTemplate: '/api/v1/reports/exports', method: 'GET', status: 200,
    durationMs: 12.4, view: 'scrap_agenda', format: 'xlsx', rowCount: 25,
  });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    requestId: 'export-id', view: 'scrap_agenda', format: 'xlsx', rowCount: 25,
  });
});
