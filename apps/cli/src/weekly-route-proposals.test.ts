import { describe, expect, it, vi } from 'vitest';
import { decidePersistedWeeklyRouteProposal, generateWeeklyRouteProposal,
  inspectPersistedWeeklyRouteProposal, saveWeeklyRouteProposal, weeklyRouteProposalSummary } from './weekly-route-proposals';

const input = {
  weekStart: '2026-11-02', generatedAt: '2026-11-04T12:00:00-03:00',
  origin: { kind: 'base_city', sellerId: '11111111-1111-4111-8111-111111111111',
    city: 'Parnamirim', state: 'RN', ibgeCode: '2403251', latitude: -5.8, longitude: -35.2,
    reference: 'municipal_seat', source: 'IBGE', configVersion: 1 },
  candidates: [
    { clientId: '22222222-2222-4222-8222-000000000001', name: 'Elegível', status: 'active',
      daysSinceLastPurchase: 180, periodicityDays: 30, averageMonthlyVolume: 50, scrapDebtKg: 500,
      location: null, hasNavigableAddress: true },
    { clientId: '22222222-2222-4222-8222-000000000002', name: 'Perdido', status: 'active',
      daysSinceLastPurchase: 181, periodicityDays: 30, averageMonthlyVolume: 50, scrapDebtKg: 500,
      location: { latitude: -5.9, longitude: -35.3 }, hasNavigableAddress: true },
  ],
};

describe('weekly route proposals CLI use case', () => {
  it('returns an inspectable rules proposal without publishing routes', () => {
    const result = generateWeeklyRouteProposal(input);
    expect(result.mode).toBe('rules');
    expect(result.days[0]?.suggestions).toHaveLength(1);
    expect(result.excluded).toEqual([{ clientId: input.candidates[1]!.clientId, reason: 'inactive_lost' }]);
  });
  it('reports policy and five daily counts', () => {
    expect(weeklyRouteProposalSummary(input)).toMatchObject({ status: 'ok',
      policyVersion: 'weekly-route-rules-v2', inactiveAfterDays: 180,
      counts: { evaluated: 2, suggested: 1, inactiveLost: 1 } });
    expect(weeklyRouteProposalSummary(input).days).toHaveLength(5);
  });

  it('operates persisted proposals through the manager API before publication', async () => {
    const proposal = generateWeeklyRouteProposal(input);
    const persisted = { schemaVersion: 1 as const, proposalId: '33333333-3333-4333-8333-333333333333',
      version: 1, status: 'draft' as const, proposal, createdBy: '44444444-4444-4444-8444-444444444444',
      createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z', publishedBy: null,
      publishedAt: null, routeIds: [] };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(persisted));
    await expect(saveWeeklyRouteProposal('http://localhost:3000', 'token', { schemaVersion: 1 }, transport))
      .resolves.toMatchObject({ status: 'draft' });
    expect(transport).toHaveBeenCalledOnce();
    const remote = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(persisted));
    await inspectPersistedWeeklyRouteProposal('http://localhost:3000', 'token', persisted.proposalId, remote);
    await decidePersistedWeeklyRouteProposal('http://localhost:3000', 'token', persisted.proposalId,
      { schemaVersion: 1, idempotencyKey: '55555555-5555-4555-8555-555555555555', expectedVersion: 1,
        decision: 'publish', reason: null }, remote);
    expect(remote).toHaveBeenNthCalledWith(1, new URL(`/api/v1/management/weekly-route-proposals/${persisted.proposalId}`,
      'http://localhost:3000'), expect.objectContaining({ cache: 'no-store' }));
    expect(remote).toHaveBeenNthCalledWith(2, expect.any(URL), expect.objectContaining({ method: 'PATCH' }));
  });

  it('rejects an unsafe origin before attaching the bearer token', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(inspectPersistedWeeklyRouteProposal('http://example.com', 'secret',
      '33333333-3333-4333-8333-333333333333', transport)).rejects.toThrow('HTTPS ou localhost');
    expect(transport).not.toHaveBeenCalled();
  });
});
