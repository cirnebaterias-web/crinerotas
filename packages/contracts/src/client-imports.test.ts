import { describe, expect, it } from 'vitest';
import {
  clientImportPreviewSchema,
  clientListQuerySchema,
  clientListResponseSchema,
} from './client-imports';

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

describe('client list pagination contracts', () => {
  it('normalizes query parameters and keeps the legacy limit alias', () => {
    expect(clientListQuerySchema.parse({ q: '  Cliente  ', page: '3', pageSize: '25' }))
      .toEqual({ q: 'Cliente', page: 3, pageSize: 25 });
    expect(clientListQuerySchema.parse({ limit: '100' }))
      .toEqual({ q: '', page: 1, pageSize: 100 });
    expect(clientListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(clientListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('requires coherent pagination metadata', () => {
    const response = {
      schemaVersion: 1 as const,
      query: 'CLIENTE-101',
      clients: [],
      pagination: {
        page: 1, pageSize: 25, totalCount: 101, totalPages: 5,
        hasPrevious: false, hasNext: true,
      },
    };
    expect(clientListResponseSchema.parse(response)).toEqual(response);
    expect(clientListResponseSchema.safeParse({
      ...response,
      pagination: { ...response.pagination, totalPages: 4 },
    }).success).toBe(false);
  });
});
