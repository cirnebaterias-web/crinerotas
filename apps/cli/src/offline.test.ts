import { expect, it } from 'vitest';
import { inspectOfflineFoundation } from './offline';

it('reports the synthetic offline contract without claiming synchronization', () => {
  expect(inspectOfflineFoundation({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  })).toEqual({
    status: 'ok',
    schemaVersion: 1,
    routeId: '33333333-3333-4333-8333-333333333333',
    stopCount: 2,
    outboxStates: ['pending', 'recoverable_error', 'action_required'],
    syncedEnabled: false,
    syntheticOnly: true,
  });
});
