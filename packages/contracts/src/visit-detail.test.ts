import { describe, expect, it } from 'vitest';
import { visitDetailResponseSchema } from './visit-detail';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-26T12:00:00.000Z';

function fixture() {
  return {
    schemaVersion: 1, visitId: id,
    context: {
      serviceDate: '2026-10-26', route: { id, versionId: id, versionNumber: 1 },
      stop: { id, plannedOrder: 1, priority: 0 },
      client: { id, externalReference: null, name: 'Cliente', address: 'Rua A' },
      seller: { id, displayName: 'Vendedor' }, parameterSet: { id, version: 1 },
    },
    status: 'in_progress', deviceStartedAt: at, serverStartedAt: at,
    deviceCompletedAt: null, serverCompletedAt: null, lastKnownUpdateAt: at,
    serverVisibilityNote: 'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
    sections: {
      stock: { state: 'absent' }, competitorPrices: { state: 'unknown_to_server' },
      commercialActions: { state: 'absent' }, scrap: { state: 'absent' }, result: { state: 'absent' },
    },
    synchronization: { status: 'confirmed', occurredAt: at, receivedAt: at, confirmedAt: at, attemptCount: 1, lastErrorCode: null },
    exceptions: [], location: { state: 'withheld' }, evidence: { state: 'withheld' }, timeline: [],
  };
}

describe('visitDetailResponseSchema', () => {
  it('accepts a strict redacted detail', () => {
    expect(visitDetailResponseSchema.parse(fixture()).location).toEqual({ state: 'withheld' });
  });

  it.each(['storagePath', 'signedUrl', 'payload', 'idempotencyKey', 'token', 'latitude'])(
    'rejects leaked field %s', (field) => {
      const value = fixture() as Record<string, unknown>;
      value[field] = 'secret';
      expect(visitDetailResponseSchema.safeParse(value).success).toBe(false);
    },
  );

  it('keeps collected and scheduled weights separate decimal strings', () => {
    const value = fixture();
    value.sections.scrap = {
      state: 'available', recordedAt: at, availability: 'scheduled',
      collectedWeightKg: null, scheduledWeightKg: '12.500', collection: null,
      schedule: { id, desiredDate: '2026-10-27', period: 'morning', status: 'pending', observation: null },
    } as never;
    expect(visitDetailResponseSchema.parse(value).sections.scrap).toMatchObject({
      collectedWeightKg: null, scheduledWeightKg: '12.500',
    });
  });
});
