import { expect, it } from 'vitest';
import { apiErrorResponseSchema, liveResponseSchema, meResponseSchema } from './index';

it('rejects extra fields and incompatible health responses', () => {
  for (const value of [{ status: 'down' }, { status: 'ok', secret: 'private' }, null, {}]) {
    expect(liveResponseSchema.safeParse(value).success).toBe(false);
  }
  expect(liveResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
});

it('validates the authenticated identity response without extra data', () => {
  const value = {
    id: 'dcd459e5-5cdc-4745-b239-0a231a9f5cd7',
    displayName: 'Vendedor A Sintético',
    roles: ['seller'],
    capabilities: ['identity.read_self'],
    scopeIds: ['dcd459e5-5cdc-4745-b239-0a231a9f5cd7'],
    status: 'active',
  };
  expect(meResponseSchema.parse(value)).toEqual(value);
  expect(meResponseSchema.safeParse({ ...value, token: 'secret' }).success).toBe(false);
  expect(meResponseSchema.safeParse({ ...value, roles: ['owner'] }).success).toBe(false);
  expect(meResponseSchema.safeParse({ ...value, capabilities: ['invalid'] }).success).toBe(false);
});

it('validates the unified error envelope', () => {
  const value = {
    error: {
      code: 'authentication_required',
      message: 'Autenticação necessária.',
      recoverable: true,
      timestamp: '2026-09-11T12:00:00.000Z',
      requestId: 'bff3dbdf-05ab-4adc-8a23-9707bad2ad6a',
    },
  };
  expect(apiErrorResponseSchema.parse(value)).toEqual(value);
  expect(apiErrorResponseSchema.safeParse({ error: { ...value.error, token: 'secret' } }).success).toBe(false);
});
