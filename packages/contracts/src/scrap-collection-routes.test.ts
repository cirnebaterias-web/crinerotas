import { describe, expect, it } from 'vitest';
import {
  approveScrapCollectionRouteSchema, assignScrapCollectionRouteSchema, createScrapCollectionRouteSchema,
  reorderScrapCollectionRouteSchema, reviseScrapCollectionRouteSchema, scrapCollectionRouteCandidateSchema,
  scrapCollectionRouteSchema,
} from './scrap-collection-routes';

describe('scrap collection route contracts', () => {
  it('keeps the execution card limited to the promised operational facts', () => {
    expect(scrapCollectionRouteCandidateSchema.parse({
      scheduleId: '11111111-1111-4111-8111-111111111111', clientName: 'Loja A',
      address: 'Rua A, 10', promisedWeightKg: '120.5', location: null,
    })).toMatchObject({ clientName: 'Loja A', promisedWeightKg: '120.5' });
  });

  it('requires one stable route identity and at least one stop', () => {
    expect(scrapCollectionRouteSchema.safeParse({ schemaVersion: 1, routeId: 'invalid', version: 1,
      routeDate: '2026-11-05', status: 'draft', operatorId: null,
      generatedAt: '2026-11-05T12:00:00Z', policy: { version: 'scrap-route-proximity-v1',
        method: 'centroid-edge-nearest-neighbor', distance: 'haversine_approximation' },
      stops: [], counts: { total: 0, geocoded: 0, pendingLocation: 0, completed: 0 } }).success).toBe(false);
  });
});

describe('scrap collection route commands', () => {
  it('rejects duplicate schedules before route creation', () => {
    const scheduleId = '00000000-0000-4000-8000-000000000001';
    expect(createScrapCollectionRouteSchema.safeParse({ schemaVersion: 1, routeDate: '2026-11-06',
      scheduleIds: [scheduleId, scheduleId] }).success).toBe(false);
  });

  it('requires a unique order and a reason to revise the plan', () => {
    expect(reorderScrapCollectionRouteSchema.safeParse({ schemaVersion: 1, expectedVersion: 1, reason: 'Ajuste operacional',
      stops: [
        { scheduleId: '00000000-0000-4000-8000-000000000001', plannedOrder: 1 },
        { scheduleId: '00000000-0000-4000-8000-000000000002', plannedOrder: 1 },
      ] }).success).toBe(false);
  });

  it('requires a version, reason and unique stops when changing route composition', () => {
    const scheduleId = '00000000-0000-4000-8000-000000000001';
    expect(reviseScrapCollectionRouteSchema.safeParse({ schemaVersion: 1, expectedVersion: 4,
      reason: 'Cliente retirado antes da saída', scheduleIds: [scheduleId, scheduleId] }).success).toBe(false);
    expect(reviseScrapCollectionRouteSchema.parse({ schemaVersion: 1, expectedVersion: 4,
      reason: 'Cliente retirado antes da saída', scheduleIds: [scheduleId] }).expectedVersion).toBe(4);
  });

  it('keeps approval and assignment as explicit versioned commands', () => {
    expect(approveScrapCollectionRouteSchema.parse({ schemaVersion: 1, expectedVersion: 2, reason: 'Plano conferido' })
      .expectedVersion).toBe(2);
    expect(assignScrapCollectionRouteSchema.parse({ schemaVersion: 1, expectedVersion: 2,
      operatorId: '00000000-0000-4000-8000-000000000004', reason: 'Escala do dia' }).operatorId)
      .toBe('00000000-0000-4000-8000-000000000004');
  });
});
