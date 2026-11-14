import { describe, expect, it } from 'vitest';
import {
  clientClassificationCatalogSchema, clientClassificationCodes, closeClientCommandSchema,
  extendSellerRouteCommandSchema, recordRouteStopAttemptCommandSchema, routeStopAttemptReasonCodes,
} from './field-route-outcomes.js';

const id = '10000000-0000-4000-8000-000000000001';

describe('field route outcome contracts', () => {
  it('publishes exactly the 13 stable classification codes', () => {
    expect(clientClassificationCodes).toHaveLength(13);
    expect(new Set(clientClassificationCodes).size).toBe(13);
    expect(clientClassificationCatalogSchema.safeParse({ schemaVersion: 1, values: [] }).success).toBe(false);
  });

  it('requires an observation only for the other non-visit reason', () => {
    const base = { schemaVersion: 1, offlineId: id, routeVersionStopId: id,
      evidence: { attachmentOfflineId: id, latitude: -5.8, longitude: -35.2, accuracyM: 8,
        capturedAt: '2026-11-13T12:00:00-03:00' } };
    expect(routeStopAttemptReasonCodes).toHaveLength(9);
    expect(recordRouteStopAttemptCommandSchema.safeParse({ ...base, reasonCode: 'other' }).success).toBe(false);
    expect(recordRouteStopAttemptCommandSchema.safeParse({ ...base, reasonCode: 'other', observation: 'Outro impedimento.' }).success).toBe(true);
    expect(recordRouteStopAttemptCommandSchema.safeParse({ ...base, reasonCode: 'client_closed' }).success).toBe(true);
  });

  it('keeps closure and route extension commands strict and versioned', () => {
    expect(closeClientCommandSchema.safeParse({ schemaVersion: 1, clientId: id, reason: 'Encerrou atividades' }).success).toBe(true);
    expect(extendSellerRouteCommandSchema.safeParse({ schemaVersion: 1, routeId: id, expectedVersion: 2, clientId: id }).success).toBe(true);
    expect(extendSellerRouteCommandSchema.safeParse({ schemaVersion: 1, routeId: id, expectedVersion: 0, clientId: id }).success).toBe(false);
  });
});
