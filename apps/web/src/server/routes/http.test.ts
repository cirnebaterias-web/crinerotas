import { afterEach, describe, expect, it } from 'vitest';
import { RouteServiceFailure } from './service';
import {
  currentServiceDate,
  enforceRouteCookieCsrf,
  mapRouteRequestError,
  readRouteJson,
} from './http';

afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.OPERATIONAL_TIME_ZONE;
});

describe('route HTTP boundary', () => {
  it('uses an injected clock in the explicit operational time zone', () => {
    const clock = () => new Date('2026-09-16T01:30:00.000Z');
    expect(currentServiceDate('America/Sao_Paulo', clock)).toBe('2026-09-15');
    expect(currentServiceDate('UTC', clock)).toBe('2026-09-16');
  });

  it('requires same-origin CSRF evidence for cookie mutations but not Bearer', () => {
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';
    expect(() => enforceRouteCookieCsrf(new Request('http://127.0.0.1:3000/api/v1/routes', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-token' },
    }))).not.toThrow();
    expect(() => enforceRouteCookieCsrf(new Request('http://127.0.0.1:3000/api/v1/routes', {
      method: 'POST',
      headers: { Origin: 'https://foreign.invalid', 'X-CSRF-Token': 'cirne-route-v1' },
    }))).toThrow();
  });

  it('rejects invalid media types and oversized route bodies', async () => {
    await expect(readRouteJson(new Request('http://local.invalid', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' },
    }))).rejects.toMatchObject({ status: 415, code: 'VALIDATION_FAILED' });
    await expect(readRouteJson(new Request('http://local.invalid', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' },
    }))).rejects.toMatchObject({ status: 413, code: 'VALIDATION_FAILED' });
  });

  it('maps repository details to a stable public error', () => {
    const mapped = mapRouteRequestError(new RouteServiceFailure('VERSION_CONFLICT', 'database detail', false));
    expect(mapped).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      message: 'A versão enviada conflita com o servidor.',
      recoverable: false,
    });
  });
});
