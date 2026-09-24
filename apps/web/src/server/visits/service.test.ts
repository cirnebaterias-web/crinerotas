import { describe, expect, it, vi } from 'vitest';
import type {
  VisitCompetitorPricesRepository,
  CompetitorPriceParametersRepository,
  VisitRepository,
  VisitStockRepository,
} from './service';
import {
  saveVisitCompetitorPrices,
  getCurrentCompetitorPriceParameters,
  saveVisitStock,
  startVisit,
  VisitServiceFailure,
} from './service';

const deviceId = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '77777777-7777-4777-8777-777777777777';
const command = {
  schemaVersion: 1 as const,
  offlineId: '55555555-5555-4555-8555-555555555555',
  routeVersionStopId: '44444444-4444-4444-8444-444444444444',
  deviceStartedAt: '2026-09-17T12:00:00.000Z',
};

const canonical = {
  schemaVersion: 1 as const,
  visitId: '88888888-8888-4888-8888-888888888888',
  offlineId: command.offlineId,
  deviceId,
  routeVersionStopId: command.routeVersionStopId,
  routeVersionId: '99999999-9999-4999-8999-999999999999',
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sellerId: '11111111-1111-4111-8111-111111111111',
  parameterSetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  status: 'in_progress' as const,
  contextSnapshot: {
    schemaVersion: 1 as const,
    sourceRouteVersionId: '99999999-9999-4999-8999-999999999999',
    snapshotCreatedAt: '2026-09-17T12:00:01.000Z',
    route: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      versionNumber: 1,
      serviceDate: '2026-09-17',
      publishedAt: '2026-09-17T08:00:00.000Z',
      plannedOrder: 1,
      priority: 1,
    },
    client: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      externalReference: null,
      name: 'Cliente Sintético',
      address: 'Endereço sintético',
      latitude: null,
      longitude: null,
      portfolioReference: null,
    },
    seller: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Vendedor Sintético' },
    parameters: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1 },
  },
  deviceStartedAt: command.deviceStartedAt,
  serverStartedAt: '2026-09-17T12:00:01.000Z',
};

describe('startVisit', () => {
  it('validates identifiers and accepts only a matching canonical result', async () => {
    const repository: VisitRepository = { start: vi.fn().mockResolvedValue(canonical) };
    await expect(startVisit(deviceId, idempotencyKey, command, repository)).resolves.toEqual(canonical);
    expect(repository.start).toHaveBeenCalledWith(deviceId, idempotencyKey, command);
    const postgresTimestamp = { ...canonical, deviceStartedAt: '2026-09-17T12:00:00+00:00' };
    await expect(startVisit(deviceId, idempotencyKey, command, {
      start: vi.fn().mockResolvedValue(postgresTimestamp),
    })).resolves.toEqual(postgresTimestamp);

    await expect(startVisit('invalid', idempotencyKey, command, repository)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      recoverable: false,
    });
    const divergent: VisitRepository = {
      start: vi.fn().mockResolvedValue({ ...canonical, offlineId: crypto.randomUUID() }),
    };
    await expect(startVisit(deviceId, idempotencyKey, command, divergent)).rejects.toBeInstanceOf(VisitServiceFailure);
    await expect(startVisit(deviceId, idempotencyKey, command, divergent)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      recoverable: true,
    });
  });
});

describe('saveVisitStock', () => {
  it('accepts zero and rejects a canonical response for another visit', async () => {
    const stock = {
      schemaVersion: 1 as const,
      offlineId: command.offlineId,
      heliarQuantity: 0,
      mouraQuantity: 5,
      deviceSavedAt: '2026-09-17T12:05:00.000Z',
    };
    const result = {
      schemaVersion: 1 as const,
      stockSnapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      visitId: canonical.visitId,
      offlineId: command.offlineId,
      heliarQuantity: 0,
      mouraQuantity: 5,
      serverSavedAt: '2026-09-17T12:05:01.000Z',
    };
    const repository: VisitStockRepository = { saveStock: vi.fn().mockResolvedValue(result) };
    await expect(saveVisitStock(command.offlineId, deviceId, idempotencyKey, stock, repository))
      .resolves.toEqual(result);
    await expect(saveVisitStock(command.offlineId, deviceId, idempotencyKey, stock, {
      saveStock: vi.fn().mockResolvedValue({ ...result, offlineId: crypto.randomUUID() }),
    })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await expect(saveVisitStock(command.offlineId, deviceId, idempotencyKey, {
      ...stock, mouraQuantity: -1,
    }, repository)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('saveVisitCompetitorPrices', () => {
  it('accepts the unavailable flow and rejects a divergent canonical response', async () => {
    const unavailableReasonId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const prices = {
      schemaVersion: 1 as const,
      offlineId: command.offlineId,
      availability: 'unavailable' as const,
      unavailableReasonId,
      deviceSavedAt: '2026-09-17T12:06:00.000Z',
    };
    const result = {
      schemaVersion: 1 as const,
      reportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      visitId: canonical.visitId,
      offlineId: command.offlineId,
      availability: 'unavailable' as const,
      quotationIds: [],
      unavailableReasonId,
      serverSavedAt: '2026-09-17T12:06:01.000Z',
    };
    const repository: VisitCompetitorPricesRepository = {
      saveCompetitorPrices: vi.fn().mockResolvedValue(result),
    };
    await expect(saveVisitCompetitorPrices(
      command.offlineId, deviceId, idempotencyKey, prices, repository,
    )).resolves.toEqual(result);
    await expect(saveVisitCompetitorPrices(command.offlineId, deviceId, idempotencyKey, prices, {
      saveCompetitorPrices: vi.fn().mockResolvedValue({ ...result, quotationIds: [crypto.randomUUID()] }),
    })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await expect(saveVisitCompetitorPrices(command.offlineId, deviceId, idempotencyKey, {
      ...prices, unavailableReasonId: 'invalid',
    }, repository)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('getCurrentCompetitorPriceParameters', () => {
  it('accepts a published parameter set valid at the requested instant', async () => {
    const parameters = {
      schemaVersion: 1 as const,
      parameterSetId: canonical.parameterSetId,
      version: 1,
      validFrom: '2026-09-17T00:00:00.000Z',
      values: { competitors: [], technologies: [], conditions: [], unavailableReasons: [] },
    };
    const repository: CompetitorPriceParametersRepository = {
      getCurrentCompetitorPriceParameters: vi.fn().mockResolvedValue(parameters),
    };
    await expect(getCurrentCompetitorPriceParameters(
      '2026-09-17T12:00:00.000Z', repository,
    )).resolves.toEqual(parameters);
    await expect(getCurrentCompetitorPriceParameters('invalid', repository))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(getCurrentCompetitorPriceParameters('2026-09-16T12:00:00.000Z', repository))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
