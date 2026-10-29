import { describe, expect, it, vi } from 'vitest';
import {
  currentOperationalWeek,
  fieldIntelligenceExitCodes,
  formatFieldIntelligence,
  loadFieldIntelligence,
  resolveFieldIntelligenceFilters,
  runFieldIntelligenceCommand,
} from './field-intelligence';

const visibility = 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.';

describe('field intelligence CLI', () => {
  it('uses the current operational Monday-to-Sunday week', () => {
    expect(currentOperationalWeek('America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });

  it('rejects partial and incompatible filters before HTTP', () => {
    expect(() => resolveFieldIntelligenceFilters({ section: 'stock', from: '2026-10-01' }, 'UTC')).toThrow('juntos');
    expect(() => resolveFieldIntelligenceFilters({
      section: 'scrap', from: '2026-10-01', to: '2026-10-02',
      competitorId: '11111111-1111-4111-8111-111111111111',
    }, 'UTC')).toThrow('Concorrente');
  });

  it('returns the empty exit code for a valid empty response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, section: 'results',
      filters: { section: 'results', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T15:00:00.000Z', lastConfirmedAt: null, nextCursor: null,
      serverVisibilityNote: visibility,
      indicators: { records: 0, completedVisits: 0 }, records: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await runFieldIntelligenceCommand({
      baseUrl: 'https://cirne.invalid', token: 'synthetic', json: true,
      values: { section: 'results' }, timeZone: 'America/Sao_Paulo',
      clock: { now: () => new Date('2026-10-28T15:00:00.000Z') }, request,
    });
    expect(result.exitCode).toBe(fieldIntelligenceExitCodes.empty);
    expect(request).toHaveBeenCalledOnce();
  });

  it('maps access denial and dependency failure to stable process codes', async () => {
    const filters = resolveFieldIntelligenceFilters({ section: 'stock' }, 'America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    });
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'FORBIDDEN', message: 'Acesso negado.', recoverable: false,
      timestamp: '2026-10-28T15:00:00.000Z', requestId: '11111111-1111-4111-8111-111111111111',
    } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    await expect(loadFieldIntelligence('https://cirne.invalid', 'synthetic', filters, denied))
      .rejects.toMatchObject({ exitCode: fieldIntelligenceExitCodes.accessDenied });

    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(loadFieldIntelligence('https://cirne.invalid', 'synthetic', filters, unavailable))
      .rejects.toMatchObject({ exitCode: fieldIntelligenceExitCodes.dependencyFailure });

    const stalledBody = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: () => Promise.reject(new DOMException('timed out', 'AbortError')) } as Response;
    });
    await expect(loadFieldIntelligence('https://cirne.invalid', 'synthetic', filters, stalledBody))
      .rejects.toMatchObject({ exitCode: fieldIntelligenceExitCodes.dependencyFailure });
  });

  it('prints records and the opaque continuation cursor in human mode', () => {
    const cursor = 'eyJwYWdlIjoyfQ';
    const output = formatFieldIntelligence({
      schemaVersion: 1,
      section: 'results',
      filters: { section: 'results', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T15:00:00.000Z',
      lastConfirmedAt: '2026-10-28T14:00:00.000Z',
      nextCursor: cursor,
      serverVisibilityNote: visibility,
      indicators: { records: 51, completedVisits: 51 },
      records: [{
        recordId: '11111111-1111-4111-8111-111111111111',
        visitId: '22222222-2222-4222-8222-222222222222',
        serviceDate: '2026-10-28',
        seller: { id: '33333333-3333-4333-8333-333333333333', name: 'Vendedor sintético' },
        client: { id: '44444444-4444-4444-8444-444444444444', name: 'Cliente sintético' },
        confirmedAt: '2026-10-28T14:00:00.000Z',
        outcome: 'completed',
        deviceStartedAt: '2026-10-28T13:00:00.000Z',
        serverStartedAt: '2026-10-28T13:00:01.000Z',
        deviceCompletedAt: '2026-10-28T13:59:59.000Z',
        serverCompletedAt: '2026-10-28T14:00:00.000Z',
      }],
    });
    expect(output).toContain('Registro 1:');
    expect(output).toContain('Cliente sintético');
    expect(output).toContain(`Próximo cursor: ${cursor}`);
  });
});
