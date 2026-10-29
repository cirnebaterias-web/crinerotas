import { describe, expect, it } from 'vitest';
import { scrapAgendaFilterSchema, scrapAgendaResponseSchema } from './index';

const sellerId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const scheduleId = '33333333-3333-4333-8333-333333333333';

describe('scrap agenda contract', () => {
  it('normalizes pending and rejects inverted intervals or unknown states', () => {
    expect(scrapAgendaFilterSchema.parse({
      from: '2026-10-26', to: '2026-11-01', period: 'morning', sellerId, clientId,
    }).status).toBe('pending');
    expect(scrapAgendaFilterSchema.safeParse({
      from: '2026-11-01', to: '2026-10-26', status: 'pending',
    }).success).toBe(false);
    expect(scrapAgendaFilterSchema.safeParse({
      from: '2026-10-26', to: '2026-11-01', status: 'completed',
    }).success).toBe(false);
  });

  it('keeps estimated weight in a strict server-confirmed response', () => {
    const parsed = scrapAgendaResponseSchema.parse({
      schemaVersion: 1,
      filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending' },
      generatedAt: '2026-10-28T15:00:00.000Z',
      lastServerConfirmedAt: '2026-10-28T14:00:00.000Z',
      indicators: { records: 1, scheduledKg: '125.50' },
      records: [{
        id: scheduleId, offlineId: '44444444-4444-4444-8444-444444444444',
        client: { id: clientId, name: 'Cliente sintético', address: 'Endereço sintético' },
        seller: { id: sellerId, displayName: 'Vendedor sintético' },
        origin: 'visit', visitId: '55555555-5555-4555-8555-555555555555',
        estimatedWeightKg: '125.50', desiredDate: '2026-10-29', period: 'morning',
        observation: null, requestedAt: '2026-10-28T13:00:00.000Z',
        serverSavedAt: '2026-10-28T14:00:00.000Z', status: 'pending', version: 1,
      }],
      nextCursor: null,
      serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
    });
    expect(parsed.indicators.scheduledKg).toBe('125.50');
    expect(parsed.records[0]?.status).toBe('pending');
  });

  it('rejects collection fields and arbitrary response data', () => {
    expect(scrapAgendaResponseSchema.safeParse({
      schemaVersion: 1,
      filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending' },
      generatedAt: '2026-10-28T15:00:00.000Z', lastServerConfirmedAt: null,
      indicators: { records: 0, scheduledKg: '0', collectedKg: '10' },
      records: [], nextCursor: null,
      serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
    }).success).toBe(false);
  });
});
