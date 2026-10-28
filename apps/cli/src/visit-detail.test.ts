import { describe, expect, it, vi } from 'vitest';
import { formatVisitDetail, parseVisitId, runVisitDetailCommand, VisitDetailCliError } from './visit-detail';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-26T12:00:00.000Z';
const detail = {
  schemaVersion: 1, visitId: id,
  context: { serviceDate: '2026-10-26', route: { id, versionId: id, versionNumber: 1 },
    stop: { id, plannedOrder: 1, priority: 0 }, client: { id, externalReference: null, name: 'Cliente', address: 'Rua A' },
    seller: { id, displayName: 'Vendedor' }, parameterSet: { id, version: 1 } },
  status: 'in_progress', deviceStartedAt: at, serverStartedAt: at, deviceCompletedAt: null,
  serverCompletedAt: null, lastKnownUpdateAt: at,
  serverVisibilityNote: 'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
  sections: { stock: { state: 'absent' }, competitorPrices: { state: 'absent' },
    commercialActions: { state: 'absent' }, scrap: { state: 'absent' }, result: { state: 'absent' } },
  synchronization: { status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at, attemptCount: 1, lastErrorCode: null },
  exceptions: [], location: { state: 'withheld' }, evidence: { state: 'withheld' }, timeline: [],
};

describe('visit detail CLI', () => {
  it('rejects invalid identifiers before fetch', async () => {
    expect(() => parseVisitId('offline-ref')).toThrow(VisitDetailCliError);
    const request = vi.fn();
    await expect(runVisitDetailCommand({ baseUrl: 'http://localhost', token: 'x', visitId: 'bad', json: true, request }))
      .rejects.toMatchObject({ exitCode: 64 });
    expect(request).not.toHaveBeenCalled();
  });

  it('emits stable JSON', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    const result = await runVisitDetailCommand({ baseUrl: 'http://localhost', token: 'x', visitId: id, json: true, request });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual(detail);
  });

  it('redacts coordinates, storage paths and URLs from human output', () => {
    const output = formatVisitDetail(detail as never);
    expect(output).toContain('oculto por permissão');
    expect(output).not.toMatch(/latitude|longitude|storage|signed|https?:\/\//iu);
  });

  it.each([[404, 66], [403, 77], [422, 64], [503, 69]])('maps HTTP %i to exit %i', async (status, exitCode) => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status }));
    await expect(runVisitDetailCommand({ baseUrl: 'http://localhost', token: 'x', visitId: id, json: true, request }))
      .rejects.toMatchObject({ exitCode });
  });
});
