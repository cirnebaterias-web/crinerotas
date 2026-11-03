import { describe, expect, it, vi } from 'vitest';
import { runManagementMapCommand } from './management-map';

const empty = {
  schemaVersion: 1, serviceDate: '2026-10-29', generatedAt: '2026-10-29T12:00:00.000Z',
  availability: 'empty', totals: { routes: 0, stops: 0, positioned: 0, unpositioned: 0 }, routes: [],
  serverVisibilityNote: 'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.',
};

describe('management map CLI', () => {
  it('queries the canonical endpoint and returns the empty exit code', async () => {
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[0].toString()).toContain('/api/v1/management/map?serviceDate=2026-10-29');
      return Response.json(empty);
    });
    const result = await runManagementMapCommand({
      baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', date: '2026-10-29',
      timeZone: 'America/Recife', json: false, request,
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('0 posicionada(s) · 0 sem coordenadas');
    expect(request).toHaveBeenCalledOnce();
  });

  it('maps authorization and invalid dates to stable failures', async () => {
    await expect(runManagementMapCommand({
      baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', date: '29/10/2026',
      timeZone: 'America/Recife', json: true,
    })).rejects.toMatchObject({ exitCode: 64 });
    await expect(runManagementMapCommand({
      baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', date: '2026-10-29',
      timeZone: 'America/Recife', json: true,
      request: vi.fn(async () => Response.json({ error: {
        code: 'FORBIDDEN', message: 'Operação não autorizada.', recoverable: false,
        timestamp: '2026-10-29T12:00:00.000Z', requestId: '10000000-0000-4000-8000-000000000009',
      } }, { status: 403 })),
    })).rejects.toMatchObject({ exitCode: 77 });
  });
});
