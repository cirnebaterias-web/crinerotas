import { describe, expect, it } from 'vitest';
import { clientImportPreviewSchema } from './client-imports';

const preview = {
  schemaVersion: 1 as const,
  sourceName: 'clientes.xlsx',
  sourceChecksum: 'a'.repeat(64),
  totalCount: 1,
  acceptedCount: 1,
  rejectedCount: 0,
  rows: [{
    rowNumber: 2,
    externalReference: 'C-001',
    name: 'Cliente Sintético',
    address: 'Rua Sintética, 1',
    latitude: -5.79,
    longitude: -35.21,
    portfolioReference: null,
    sellerEmail: 'seller@example.invalid',
    status: 'active' as const,
  }],
  issues: [],
};

describe('clientImportPreviewSchema', () => {
  it('aceita contadores coerentes com as linhas', () => {
    expect(clientImportPreviewSchema.parse(preview)).toEqual(preview);
  });

  it('rejeita contadores incoerentes', () => {
    expect(clientImportPreviewSchema.safeParse({ ...preview, acceptedCount: 0 }).success).toBe(false);
    expect(clientImportPreviewSchema.safeParse({ ...preview, totalCount: 2 }).success).toBe(false);
  });
});
