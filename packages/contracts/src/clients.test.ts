import { describe, expect, it } from 'vitest';
import {
  createClientRequestSchema,
  normalizeClientExternalReference,
  updateClientRequestSchema,
} from './index';

const base = {
  schemaVersion: 1 as const,
  name: 'Cliente Sintético',
  address: 'Rua Sintética, 10',
  latitude: null,
  longitude: null,
  portfolioReference: null,
  sellerEmail: 'SELLER@EXAMPLE.INVALID',
  status: 'active' as const,
};

describe('client management contracts', () => {
  it('shares a stable normalization for formatted official identifiers', () => {
    expect(normalizeClientExternalReference(' 12.345.678/0001-90 ')).toBe('12345678000190');
    expect(normalizeClientExternalReference(' ref  externa-01 ')).toBe('REF EXTERNA-01');
    expect(createClientRequestSchema.parse({ ...base, externalReference: '12.345.678/0001-90' }))
      .toMatchObject({ externalReference: '12345678000190', sellerEmail: 'seller@example.invalid' });
  });

  it('requires paired coordinates and mandatory edit reason/version', () => {
    expect(createClientRequestSchema.safeParse({
      ...base, externalReference: 'CLIENT-001', latitude: -5.79,
    }).success).toBe(false);
    expect(updateClientRequestSchema.safeParse({ ...base, expectedVersion: 1, reason: '' }).success)
      .toBe(false);
    expect(updateClientRequestSchema.safeParse({
      ...base, expectedVersion: 1, reason: 'Correção autorizada', latitude: -5.79, longitude: -35.21,
    }).success).toBe(true);
  });
});
