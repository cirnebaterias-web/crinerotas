import { localRouteBundleSchema, offlineOutboxStatusSchema, type OfflinePartition } from '@cirne/contracts';
import { createSyntheticRouteBundle } from '@cirne/domain';

export function inspectOfflineFoundation(partition: OfflinePartition) {
  const bundle = localRouteBundleSchema.parse(
    createSyntheticRouteBundle(partition, '2026-09-11T12:00:00.000Z'),
  );
  return {
    status: 'ok' as const,
    schemaVersion: bundle.schemaVersion,
    routeId: bundle.routeId,
    stopCount: bundle.stops.length,
    outboxStates: offlineOutboxStatusSchema.options,
    syncedEnabled: true,
    syntheticOnly: bundle.stops.every((stop) => stop.displayLabel.includes('sintética')),
  };
}
