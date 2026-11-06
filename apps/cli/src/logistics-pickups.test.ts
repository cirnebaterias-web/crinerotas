import { describe, expect, it, vi } from 'vitest';
import { runLogisticsPickupCommand } from './logistics-pickups';

describe('logistics operational CLI', () => {
  it('loads the chosen day using bearer and the shared read contract', async () => {
    const data = { schemaVersion: 1, date: '2026-11-04', generatedAt: '2026-11-04T10:00:00Z', records: [],
      totals: { promisedWeightKg: '0', collectedWeightKg: '0', differenceKg: '0', pending: 0, reviewRequired: 0 } };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    await expect(runLogisticsPickupCommand({ baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', operation: 'list', date: '2026-11-04', request })).resolves.toEqual(data);
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/v1/logistics/pickups?date=2026-11-04');
  });
  it('never generates a new idempotency key for an incomplete mutation', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(runLogisticsPickupCommand({ baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', operation: 'result', request })).rejects.toMatchObject({ exitCode: 64 });
    expect(request).not.toHaveBeenCalled();
  });
  it('surfaces forbidden and conflict responses as distinct exit codes', async () => {
    for (const [status, exitCode] of [[403, 77], [409, 75]]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status }));
      await expect(runLogisticsPickupCommand({ baseUrl: 'http://127.0.0.1:3000', token: 'synthetic', operation: 'operators', request })).rejects.toMatchObject({ exitCode });
    }
  });
});
