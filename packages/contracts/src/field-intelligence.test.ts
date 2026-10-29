import { describe, expect, it } from 'vitest';
import { fieldIntelligenceFilterSchema, fieldIntelligenceResponseSchema } from './field-intelligence';

const sellerId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';

describe('field intelligence contract', () => {
  it('accepts canonical filters and rejects inverted or incompatible filters', () => {
    expect(fieldIntelligenceFilterSchema.safeParse({
      section: 'prices', from: '2026-10-26', to: '2026-11-01', sellerId, clientId,
      competitorId: '33333333-3333-4333-8333-333333333333',
    }).success).toBe(true);
    expect(fieldIntelligenceFilterSchema.safeParse({
      section: 'stock', from: '2026-11-01', to: '2026-10-26',
    }).success).toBe(false);
    expect(fieldIntelligenceFilterSchema.safeParse({
      section: 'scrap', from: '2026-10-26', to: '2026-11-01', competitorId: sellerId,
    }).success).toBe(false);
    expect(fieldIntelligenceFilterSchema.safeParse({
      section: 'prices', from: '2026-10-26', to: '2026-11-01', actionType: 'other',
    }).success).toBe(false);
  });

  it('keeps collected and scheduled weight in independent decimal indicators', () => {
    const parsed = fieldIntelligenceResponseSchema.parse({
      schemaVersion: 1,
      section: 'scrap',
      filters: { section: 'scrap', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T15:00:00.000Z',
      lastConfirmedAt: null,
      nextCursor: null,
      serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
      indicators: {
        records: 0, collectedRecords: 0, scheduledRecords: 0,
        collectedWeightKg: '0', scheduledWeightKg: '0',
      },
      records: [],
    });
    expect(parsed.section).toBe('scrap');
    if (parsed.section !== 'scrap') throw new Error('Expected scrap response.');
    expect(parsed.indicators.collectedWeightKg).toBe('0');
    expect(parsed.indicators.scheduledWeightKg).toBe('0');
  });

  it('rejects unknown response fields and floating-point weights', () => {
    expect(fieldIntelligenceResponseSchema.safeParse({
      schemaVersion: 1, section: 'results',
      filters: { section: 'results', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T15:00:00.000Z', lastConfirmedAt: null, nextCursor: null,
      serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
      indicators: { records: 0, completedVisits: 0 }, records: [], sql: 'forbidden',
    }).success).toBe(false);
  });

  it('requires the historical competitor label on an identified action', () => {
    const base = {
      schemaVersion: 1, section: 'actions',
      filters: { section: 'actions', from: '2026-10-26', to: '2026-11-01' },
      generatedAt: '2026-10-28T15:00:00.000Z', lastConfirmedAt: '2026-10-28T14:00:00.000Z',
      nextCursor: null,
      serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
      indicators: { records: 1, identifiedRecords: 1, actions: 1 },
      records: [{ recordId: sellerId, visitId: clientId, serviceDate: '2026-10-28',
        seller: { id: sellerId, name: 'Vendedor' }, client: { id: clientId, name: 'Cliente' },
        confirmedAt: '2026-10-28T14:00:00.000Z', availability: 'identified',
        actions: [{ id: '33333333-3333-4333-8333-333333333333',
          competitor: { id: '44444444-4444-4444-8444-444444444444', label: 'Concorrente' },
          actionType: 'other', otherType: 'Ação local', description: 'Descrição histórica',
          validFrom: '2026-10-28', validUntil: '2026-10-31' }],
      }],
    };
    expect(fieldIntelligenceResponseSchema.safeParse(base).success).toBe(true);
    const withoutLabel = structuredClone(base);
    delete (withoutLabel.records[0]!.actions[0]!.competitor as { label?: string }).label;
    expect(fieldIntelligenceResponseSchema.safeParse(withoutLabel).success).toBe(false);
  });
});
