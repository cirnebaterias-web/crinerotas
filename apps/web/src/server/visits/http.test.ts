import { afterEach, describe, expect, it } from 'vitest';
import { VisitServiceFailure } from './service';
import {
  enforceVisitCookieCsrf,
  mapVisitRequestError,
  readVisitJson,
} from './http';

afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.OPERATIONAL_TIME_ZONE;
});

describe('visit HTTP boundary', () => {
  it('requires same-origin CSRF evidence for cookie mutations but accepts Bearer', () => {
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';
    expect(() => enforceVisitCookieCsrf(new Request('http://127.0.0.1:3000/api/v1/visits', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-token' },
    }))).not.toThrow();
    expect(() => enforceVisitCookieCsrf(new Request('http://127.0.0.1:3000/api/v1/visits', {
      method: 'POST',
      headers: { Origin: 'https://foreign.invalid', 'X-CSRF-Token': 'cirne-visit-v1' },
    }))).toThrow();
    expect(() => enforceVisitCookieCsrf(new Request('http://127.0.0.1:3000/api/v1/visits', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:3000', 'X-CSRF-Token': 'cirne-visit-v1' },
    }))).not.toThrow();
  });

  it('rejects invalid media types, malformed JSON and oversized bodies', async () => {
    await expect(readVisitJson(new Request('http://local.invalid', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' },
    }))).rejects.toMatchObject({ status: 415, code: 'VALIDATION_FAILED' });
    await expect(readVisitJson(new Request('http://local.invalid', {
      method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' },
    }))).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(readVisitJson(new Request('http://local.invalid', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' },
    }))).rejects.toMatchObject({ status: 413, code: 'VALIDATION_FAILED' });
  });

  it('maps private repository details to a stable non-enumerating error', () => {
    const forbidden = mapVisitRequestError(new VisitServiceFailure('NOT_FOUND', 'database detail', false));
    expect(forbidden).toMatchObject({
      status: 403,
      code: 'NOT_FOUND',
      message: 'Visita não encontrada ou indisponível.',
      recoverable: false,
    });
    const conflict = mapVisitRequestError(new VisitServiceFailure(
      'IDEMPOTENCY_KEY_REUSED',
      'database detail',
      false,
    ));
    expect(conflict).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
