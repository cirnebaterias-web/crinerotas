import { expect, it } from 'vitest';
import { inspectOfflineFoundation } from './offline';

it('reports the canonical offline snapshot while preserving the legacy contract', () => {
  expect(inspectOfflineFoundation({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  })).toEqual({
    status: 'ok',
    schemaVersion: 2,
    legacySchemaVersion: 1,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersionId: '44444444-4444-4444-8444-444444444444',
    stopCount: 1,
    outboxStates: ['pending', 'sending', 'recoverable_error', 'action_required'],
    syncedEnabled: true,
    canonicalSnapshot: true,
    syntheticOnly: true,
  });
});
