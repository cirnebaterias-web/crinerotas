import { describe, expect, it, vi } from 'vitest';
import {
  formatScrapAgenda,
  loadScrapAgenda,
  resolveScrapAgendaFilters,
  runScrapAgendaCommand,
  scrapAgendaExitCodes,
} from './scrap-agenda';

const visibility = 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.' as const;
const emptyResponse = {
  schemaVersion: 1 as const,
  filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending' as const },
  generatedAt: '2026-10-28T15:00:00.000Z', lastServerConfirmedAt: null,
  indicators: { records: 0, scheduledKg: '0' }, records: [], nextCursor: null,
  serverVisibilityNote: visibility,
};

describe('scrap agenda CLI', () => {
  it('uses the operational week and validates filters before HTTP', () => {
    expect(resolveScrapAgendaFilters({}, 'America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual({ from: '2026-10-26', to: '2026-11-01', status: 'pending' });
    expect(() => resolveScrapAgendaFilters({ from: '2026-10-01' }, 'UTC')).toThrow('juntos');
    expect(() => resolveScrapAgendaFilters({ status: 'completed' }, 'UTC')).toThrow();
  });

  it('returns the empty exit code for a valid response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(emptyResponse), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await runScrapAgendaCommand({
      baseUrl: 'https://cirne.invalid', token: 'synthetic', values: {}, json: true,
      timeZone: 'America/Sao_Paulo', clock: { now: () => new Date('2026-10-28T15:00:00.000Z') }, request,
    });
    expect(result.exitCode).toBe(scrapAgendaExitCodes.empty);
    expect(request).toHaveBeenCalledOnce();
  });

  it('maps denial and dependency failures to stable codes', async () => {
    const filters = resolveScrapAgendaFilters({}, 'UTC', { now: () => new Date('2026-10-28T15:00:00.000Z') });
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'FORBIDDEN', message: 'Acesso negado.', recoverable: false,
      timestamp: '2026-10-28T15:00:00.000Z', requestId: '11111111-1111-4111-8111-111111111111',
    } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await expect(loadScrapAgenda('https://cirne.invalid', 'synthetic', filters, denied))
      .rejects.toMatchObject({ exitCode: scrapAgendaExitCodes.accessDenied });
    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(loadScrapAgenda('https://cirne.invalid', 'synthetic', filters, unavailable))
      .rejects.toMatchObject({ exitCode: scrapAgendaExitCodes.dependencyFailure });
  });

  it('prints pending records and continuation cursor in human mode', () => {
    const output = formatScrapAgenda({
      ...emptyResponse,
      indicators: { records: 1, scheduledKg: '25' },
      lastServerConfirmedAt: '2026-10-28T14:00:00.000Z', nextCursor: 'eyJwYWdlIjoyfQ',
      records: [{
        id: '11111111-1111-4111-8111-111111111111', offlineId: '22222222-2222-4222-8222-222222222222',
        client: { id: '33333333-3333-4333-8333-333333333333', name: 'Cliente sintético', address: 'Endereço sintético' },
        seller: { id: '44444444-4444-4444-8444-444444444444', displayName: 'Vendedor sintético' },
        origin: 'standalone', visitId: null, estimatedWeightKg: '25', desiredDate: '2026-10-30',
        period: 'afternoon', observation: null, requestedAt: '2026-10-28T13:00:00.000Z',
        serverSavedAt: '2026-10-28T14:00:00.000Z', status: 'pending', version: 1,
      }],
    });
    expect(output).toContain('Cliente sintético');
    expect(output).toContain('25 kg · Pendente');
    expect(output).toContain('Próximo cursor: eyJwYWdlIjoyfQ');
    expect(output).not.toContain('Coletado');
  });
});
