import { describe, expect, it, vi } from 'vitest';
import type { CreateRouteDraftRequest } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseRouteRepository } from './supabase-repository';

const command: CreateRouteDraftRequest = {
  schemaVersion: 1,
  serviceDate: '2026-09-15',
  sellerId: '11111111-1111-4111-8111-111111111111',
  stops: [{ clientId: '10000000-0000-4000-8000-000000000001', plannedOrder: 1, priority: 0 }],
};

function clientReturning(data: unknown, error: { message: string } | null = null) {
  const abortSignal = vi.fn().mockResolvedValue({ data, error });
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { repository: new SupabaseRouteRepository({ schema } as unknown as SupabaseClient), rpc };
}

function clientRejecting(reason: unknown) {
  const abortSignal = vi.fn().mockRejectedValue(reason);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return new SupabaseRouteRepository({ schema } as unknown as SupabaseClient);
}

describe('SupabaseRouteRepository', () => {
  it('rejects a draft response whose seller differs from the command', async () => {
    const { repository } = clientReturning({
      ...command,
      routeId: '20000000-0000-4000-8000-000000000001',
      routeVersionId: '30000000-0000-4000-8000-000000000001',
      versionNumber: 1,
      expectedVersion: 1,
      status: 'draft',
      sellerId: '11111111-1111-4111-8111-111111111112',
      stops: [{ ...command.stops[0], routeVersionStopId: '40000000-0000-4000-8000-000000000001' }],
    });
    await expect(repository.createDraft(command))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });

  it('rejects a draft response that duplicates one client and omits another', async () => {
    const twoStopCommand: CreateRouteDraftRequest = {
      ...command,
      stops: [
        command.stops[0]!,
        { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 2, priority: 1 },
      ],
    };
    const { repository } = clientReturning({
      ...twoStopCommand,
      routeId: '20000000-0000-4000-8000-000000000001',
      routeVersionId: '30000000-0000-4000-8000-000000000001',
      versionNumber: 1,
      expectedVersion: 1,
      status: 'draft',
      stops: [
        { ...twoStopCommand.stops[0], routeVersionStopId: '40000000-0000-4000-8000-000000000001' },
        {
          ...twoStopCommand.stops[0],
          routeVersionStopId: '40000000-0000-4000-8000-000000000002',
        },
      ],
    });
    await expect(repository.createDraft(twoStopCommand))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });

  it('maps known database failures without exposing their internals', async () => {
    const { repository } = clientReturning(null, { message: 'VERSION_CONFLICT' });
    await expect(repository.publish(
      '20000000-0000-4000-8000-000000000001',
      { schemaVersion: 1, expectedVersion: 1 },
    )).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: 'A versão enviada conflita com o servidor.',
      recoverable: false,
    });
  });

  it('maps rejected RPC transport promises to a recoverable dependency failure', async () => {
    const repository = clientRejecting(new Error('private transport detail'));
    await expect(repository.getForDate('2026-09-15')).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Serviço de rotas temporariamente indisponível.',
      recoverable: true,
    });
  });
});
