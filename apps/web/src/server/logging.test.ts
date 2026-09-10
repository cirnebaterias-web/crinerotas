import { expect, it } from 'vitest';
import { createLogger, logRequest } from './logging';

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
