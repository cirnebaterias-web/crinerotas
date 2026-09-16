import { describe, expect, it, vi } from 'vitest';
import type {
  CanonicalRoute,
  CreateRouteDraftRequest,
  RouteDraft,
  RoutePublication,
  RouteTodayResponse,
  ReorderRouteExecutionResult,
} from '@cirne/contracts';
import {
  createRouteDraft,
  getMyRouteForDate,
  publishRoute,
  reorderRouteExecution,
  type RouteRepository,
} from './service';

const command: CreateRouteDraftRequest = {
  schemaVersion: 1,
  serviceDate: '2026-09-15',
  sellerId: '11111111-1111-4111-8111-111111111111',
  stops: [
    { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 3, priority: 0 },
    { clientId: '10000000-0000-4000-8000-000000000001', plannedOrder: 1, priority: 1 },
  ],
};

function draftFor(input = command): RouteDraft {
  return {
    ...input,
    routeId: '20000000-0000-4000-8000-000000000001',
    routeVersionId: '30000000-0000-4000-8000-000000000001',
    versionNumber: 1,
    expectedVersion: 1,
    status: 'draft',
    stops: input.stops.map((stop, index) => ({
      ...stop,
      routeVersionStopId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
  };
}

function repository(overrides: Partial<RouteRepository> = {}): RouteRepository {
  const draft = draftFor({ ...command, stops: [...command.stops].sort((a, b) => a.plannedOrder - b.plannedOrder) });
  const publication: RoutePublication = {
    schemaVersion: 1,
    routeId: draft.routeId,
    routeVersionId: draft.routeVersionId,
    versionNumber: 1,
    expectedVersion: 2,
    status: 'published',
    publishedBy: '50000000-0000-4000-8000-000000000001',
    publishedAt: '2026-09-15T12:00:00.000Z',
    stopCount: 2,
  };
  return {
    createDraft: vi.fn(async () => draft),
    publish: vi.fn(async () => publication),
    getById: vi.fn(async () => ({} as CanonicalRoute)),
    getForDate: vi.fn(async (serviceDate): Promise<RouteTodayResponse> => ({
      schemaVersion: 2,
      availability: 'empty',
      serviceDate,
    })),
    reorder: vi.fn(async (routeId, request): Promise<ReorderRouteExecutionResult> => ({
      schemaVersion: 1,
      routeId,
      routeVersionId: draft.routeVersionId,
      executionVersion: request.expectedVersion + 1,
      changed: true,
      pendingStopIds: request.pendingStopIds,
    })),
    ...overrides,
  };
}

describe('route application services', () => {
  it('normalizes planned order before creating the draft', async () => {
    const target = repository();
    await createRouteDraft(command, target);
    expect(target.createDraft).toHaveBeenCalledWith({
      ...command,
      stops: [command.stops[1], command.stops[0]],
    });
  });

  it('rejects invalid route identifiers before publication', async () => {
    const target = repository();
    await expect(publishRoute('not-a-uuid', { schemaVersion: 1, expectedVersion: 1 }, target))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', recoverable: false });
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('maps invalid commands to a stable validation failure before repository access', async () => {
    const target = repository();
    await expect(createRouteDraft({ ...command, stops: [] }, target))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', recoverable: false });
    await expect(publishRoute(command.sellerId, { schemaVersion: 1, expectedVersion: 0 }, target))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', recoverable: false });
    expect(target.createDraft).not.toHaveBeenCalled();
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('returns a stable empty state for the injected service date', async () => {
    expect(await getMyRouteForDate('2026-09-15', repository())).toEqual({
      schemaVersion: 2,
      availability: 'empty',
      serviceDate: '2026-09-15',
    });
  });

  it('validates and forwards one aggregate execution order command with audit context', async () => {
    const target = repository();
    const request = {
      schemaVersion: 1 as const,
      expectedVersion: 2,
      pendingStopIds: [
        '40000000-0000-4000-8000-000000000002',
        '40000000-0000-4000-8000-000000000001',
      ],
    };
    const context = { requestId: '60000000-0000-4000-8000-000000000001', origin: 'cli' as const };
    await expect(reorderRouteExecution(draftFor().routeId, request, context, target))
      .resolves.toMatchObject({ changed: true, executionVersion: 3 });
    expect(target.reorder).toHaveBeenCalledWith(draftFor().routeId, request, context);
  });
});
