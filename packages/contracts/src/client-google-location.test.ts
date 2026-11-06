import { describe, expect, it } from 'vitest';
import { clientGoogleLocationSchema, clientImportRowSchema, routeClientSnapshotSchema } from './index';

const source = { address: 'Av. São Jerônimo, 402 — Mossoró', placeId: 'EjR_Address-123', status: 'PREENCHIDO', precision: 'ROOFTOP' };
const client = { id: '00000000-0000-4000-8000-000000000001', externalReference: '01234567000199', name: 'Cliente',
  address: 'Endereço cadastral', latitude: null, longitude: null, portfolioReference: null };

describe('Google client location contracts', () => {
  it('accepts address place IDs, explicit empty source values and old snapshots', () => {
    expect(clientGoogleLocationSchema.parse(source)).toEqual(source);
    expect(clientGoogleLocationSchema.parse({ address: null, placeId: null, status: null, precision: null })).toBeTruthy();
    expect(routeClientSnapshotSchema.parse(client)).not.toHaveProperty('googleLocation');
    expect(routeClientSnapshotSchema.parse({ ...client, googleLocation: source }).googleLocation).toEqual(source);
  });
  it.each(['https://evil.invalid/', 'id&origin=x', 'id id', 'x'.repeat(513), ''])('rejects malformed IDs %s', (placeId) => {
    expect(clientGoogleLocationSchema.safeParse({ ...source, placeId }).success).toBe(false);
  });
  it('requires all source fields and forbids claims of GPS verification', () => {
    expect(clientGoogleLocationSchema.safeParse({ placeId: source.placeId }).success).toBe(false);
    expect(clientGoogleLocationSchema.safeParse({ ...source, verified: true }).success).toBe(false);
  });
  it('distinguishes legacy imports from explicit removal without accepting a null command', () => {
    const row = { rowNumber: 2, externalReference: client.externalReference, name: client.name, address: client.address,
      latitude: null, longitude: null, portfolioReference: null, sellerEmail: 'seller@example.invalid', status: 'active' };
    expect(clientImportRowSchema.parse(row)).not.toHaveProperty('googleLocation');
    expect(clientImportRowSchema.safeParse({ ...row, googleLocation: null }).success).toBe(false);
    expect(clientImportRowSchema.parse({ ...row, googleLocation: source }).googleLocation).toEqual(source);
  });
});
