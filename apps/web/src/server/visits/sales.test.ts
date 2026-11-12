import { describe, expect, it, vi } from 'vitest';
import { saveVisitSales, type VisitSalesRepository } from './service';
import { SupabaseVisitRepository } from './supabase-repository';
import { processSyncBatch } from '../sync/service';
import { syncCommandSchema } from '@cirne/contracts';

const offlineId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-12T12:00:00.000Z';
const input = { schemaVersion: 1 as const, offlineId, expectedVersion: 0, heliarQuantity: 0,
  americaQuantity: 2, stradaDurexQuantity: 3, deviceSavedAt: at };
const result = { schemaVersion: 1 as const, offlineId, visitId: offlineId, reportId: key,
  version: 1, heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 3, deviceSavedAt: at, serverSavedAt: at };

describe('visit sales API boundary', () => {
  it('validates the input and canonical result, keeping zero as a declaration', async () => {
    const repository: VisitSalesRepository = { saveSales: vi.fn().mockResolvedValue(result), getSales: vi.fn() };
    await expect(saveVisitSales(offlineId, deviceId, key, input, repository)).resolves.toEqual(result);
    await expect(saveVisitSales(deviceId, deviceId, key, input, repository)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.saveSales).toHaveBeenCalledTimes(1);
    vi.mocked(repository.saveSales).mockResolvedValueOnce({ ...result, americaQuantity: 9 });
    await expect(saveVisitSales(offlineId, deviceId, key, input, repository)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
  it('dispatches sales to the normal sync API with its sequence and version intact', async () => {
    const payload = { offlineId, expectedVersion: 0, heliarQuantity: 0, americaQuantity: 2,
      stradaDurexQuantity: 3, deviceSavedAt: at };
    const command = syncCommandSchema.parse({ eventId: key, idempotencyKey: key, schemaVersion: 1,
      operation: 'visit.sales.saved.v1', aggregateType: 'visit', aggregateId: offlineId,
      sequence: 6, occurredAt: at, payload });
    const repository = { synchronize: vi.fn().mockResolvedValue({ eventId: key, status: 'confirmed', canonicalId: offlineId, confirmedAt: at }) };
    await expect(processSyncBatch({ deviceId, events: [command] }, key, repository)).resolves.toMatchObject({ results: [{ status: 'confirmed' }] });
    expect(repository.synchronize).toHaveBeenCalledWith(deviceId, command);
  });
  it('uses the narrow RPC under the caller and maps database authorization/conflict errors', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: result, error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const schema = vi.fn().mockReturnValue({ rpc });
    const repository = new SupabaseVisitRepository({ schema } as never);
    await expect(repository.saveSales(deviceId, key, input)).resolves.toEqual(result);
    expect(rpc).toHaveBeenCalledWith('save_visit_sales', { p_device_id: deviceId, p_idempotency_key: key, p_command: input });
    for (const message of ['FORBIDDEN', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED']) {
      abortSignal.mockResolvedValueOnce({ data: null, error: { message } });
      await expect(repository.saveSales(deviceId, key, input)).rejects.toMatchObject({ code: message, recoverable: false });
    }
    abortSignal.mockResolvedValueOnce({ data: null, error: null });
    await expect(repository.getSales(deviceId, offlineId)).resolves.toBeNull();
  });
});
