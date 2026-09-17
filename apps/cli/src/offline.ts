import {
  canonicalLocalRouteBundleSchema,
  localRouteBundleSchema,
  offlineOutboxStatusSchema,
  type CanonicalRoute,
  type OfflinePartition,
} from '@cirne/contracts';
import { createCanonicalLocalRouteBundle, createSyntheticRouteBundle } from '@cirne/domain';

function createSyntheticCanonicalRoute(userId: string): CanonicalRoute {
  return {
    schemaVersion: 2,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 1,
    serviceDate: '2026-09-16',
    status: 'published',
    publishedAt: '2026-09-16T12:00:00.000Z',
    executionVersion: 1,
    seller: { id: userId, displayName: 'Vendedor Sintético' },
    stops: [{
      routeVersionStopId: '55555555-5555-4555-8555-555555555555',
      plannedOrder: 1,
      executionOrder: 1,
      priority: 1,
      status: 'pending',
      executionVersion: 1,
      client: {
        id: '66666666-6666-4666-8666-666666666666',
        externalReference: 'SYN-01',
        name: 'Cliente Sintético',
        address: 'Endereço sintético',
        latitude: null,
        longitude: null,
        portfolioReference: null,
      },
    }],
  };
}

export function inspectOfflineFoundation(partition: OfflinePartition) {
  const bundle = localRouteBundleSchema.parse(
    createSyntheticRouteBundle(partition, '2026-09-11T12:00:00.000Z'),
  );
  const canonicalBundle = canonicalLocalRouteBundleSchema.parse(createCanonicalLocalRouteBundle(
    partition,
    createSyntheticCanonicalRoute(partition.userId),
    '2026-09-16T12:01:00.000Z',
  ));
  return {
    status: 'ok' as const,
    schemaVersion: canonicalBundle.schemaVersion,
    legacySchemaVersion: bundle.schemaVersion,
    routeId: canonicalBundle.routeId,
    routeVersionId: canonicalBundle.routeVersionId,
    stopCount: canonicalBundle.stops.length,
    outboxStates: offlineOutboxStatusSchema.options,
    syncedEnabled: true,
    canonicalSnapshot: true,
    syntheticOnly: canonicalBundle.stops.every((stop) => stop.client.name.includes('Sintético')),
  };
}
