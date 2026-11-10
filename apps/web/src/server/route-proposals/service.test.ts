import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientImportRpc } from '../client-imports/http';
import { getSalesSignals } from '../client-sales/crm';
import { getScrapLedgerAnalytics } from '../scrap-ledger-sync/service';
import { listManagedClientSellers } from '../clients/service';
import { proposeWeeklyRoutes } from '@cirne/domain';
import { generateWeeklyProposal, mutateWeeklyProposal } from './service';

vi.mock('../client-imports/http', () => ({ clientImportRpc: vi.fn() }));
vi.mock('../client-sales/crm', () => ({ getSalesSignals: vi.fn() }));
vi.mock('../scrap-ledger-sync/service', () => ({ getScrapLedgerAnalytics: vi.fn() }));
vi.mock('../clients/service', () => ({ listManagedClientSellers: vi.fn() }));

const sellerId = '11111111-1111-4111-8111-111111111111';
const clientId = (value: number) => `22222222-2222-4222-8222-${String(value).padStart(12, '0')}`;
const customer = (value: number) => ({ schemaVersion: 1, id: clientId(value), externalReference: `1234567800${value}`,
  name: `Cliente ${value}`, address: `Rua ${value}`, googleLocation: null, latitude: -5.8,
  longitude: -35.2, portfolioReference: 'LAYS', sellerId, sellerEmail: 'seller@example.test',
  status: 'active', version: 1 });
const page = (clients: ReturnType<typeof customer>[], number = 1, totalPages = 1) => ({ schemaVersion: 1,
  query: '', clients, pagination: { page: number, pageSize: 100, totalCount: clients.length,
    totalPages, hasPrevious: number > 1, hasNext: number < totalPages } });
const metrics = (days: number | null) => ({ lastPurchaseDate: days === null ? null : '2026-05-08',
  daysSinceLastPurchase: days, periodicityDays: 30, positivePurchaseDateCount: 2, intervalCount: 1,
  averageMonthlyVolume: 100, cycleState: 'overdue' });
const command = { schemaVersion: 1 as const, weekStart: '2026-11-02', sellerId };
const routeProfile = { schemaVersion: 1 as const, sellerId, displayName: 'Lays Andrade', lifecycle: 'active' as const,
  offboardingAt: null, portfolioState: 'assigned' as const, version: 1, updatedAt: '2026-11-04T12:00:00Z',
  baseCity: { city: 'Parnamirim', state: 'RN', ibgeCode: '2403251', latitude: -5.92, longitude: -35.27,
    reference: 'municipal_seat' as const, source: 'IBGE' as const } };
const emptyProposal = proposeWeeklyRoutes({ weekStart: command.weekStart,
  generatedAt: '2026-11-04T15:00:00Z', origin: { kind: 'base_city', sellerId,
    city: 'Parnamirim', state: 'RN', ibgeCode: '2403251', latitude: -5.92, longitude: -35.27,
    reference: 'municipal_seat', source: 'IBGE', configVersion: 1 }, candidates: [] });

describe('weekly proposal service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listManagedClientSellers).mockResolvedValue({ schemaVersion: 1,
      sellers: [{ id: sellerId, displayName: 'Lays Andrade', email: 'lays@example.test' }] });
  });

  it('loads the scoped portfolio and applies the strict 180-day rule with scrap context', async () => {
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc) =>
      rpc === 'get_seller_route_profile' ? routeProfile
        : rpc === 'get_scrap_ledger_generation_metadata'
          ? { generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z' }
          : page([customer(1), customer(2)]));
    vi.mocked(getSalesSignals).mockResolvedValue({ generationId: clientId(90), asOfDate: '2026-11-04',
      signals: [{ client: { id: clientId(1), name: 'Cliente 1' }, metrics: metrics(180) },
        { client: { id: clientId(2), name: 'Cliente 2' }, metrics: metrics(181) }] } as never);
    vi.mocked(getScrapLedgerAnalytics).mockResolvedValue({ generationId: clientId(91), view: 'balances',
      page: 1, pageSize: 50, totalCount: 1, trendMethod: 'method',
      rows: [{ client_external_reference: customer(1).externalReference, balance_kg: '-500.000', trend: 'stable' }] });
    const result = await generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z'));
    expect(result.days[0]?.suggestions[0]).toMatchObject({ clientId: clientId(1) });
    expect(result.origin).toMatchObject({ city: 'Parnamirim', ibgeCode: '2403251', reference: 'municipal_seat' });
    expect(result.days[0]?.suggestions[0]?.reasons).toContain('500 kg de débito de sucata');
    expect(result.excluded).toContainEqual({ clientId: clientId(2), name: 'Cliente 2', reason: 'inactive_lost' });
    expect(result.sources).toEqual({ sales: { status: 'available', generationId: clientId(90), asOfDate: '2026-11-04' },
      scrap: { status: 'available', generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z' },
      visits: { status: 'unavailable', asOfDate: null } });
    expect(clientImportRpc).toHaveBeenCalledWith(expect.anything(), 'list_management_clients', {
      p_query: '', p_page: 1, p_page_size: 100, p_seller_id: sellerId,
    });
  });

  it('refuses to generate a proposal when the seller has no configured base city', async () => {
    vi.mocked(listManagedClientSellers).mockResolvedValue({ schemaVersion: 1,
      sellers: [{ id: sellerId, displayName: 'Pessoa nova', email: 'new@example.test' }] });
    vi.mocked(clientImportRpc).mockResolvedValue({ ...routeProfile, displayName: 'Pessoa nova',
      version: 0, baseCity: null });
    await expect(generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z')))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect(clientImportRpc).toHaveBeenCalledWith(expect.anything(), 'get_seller_route_profile', {
      p_seller_id: sellerId,
    });
  });

  it('keeps proposal available when the official scrap source is unavailable', async () => {
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc) =>
      rpc === 'get_seller_route_profile' ? routeProfile : page([customer(1)]));
    vi.mocked(getSalesSignals).mockResolvedValue({ generationId: clientId(90), asOfDate: '2026-11-04',
      signals: [{ client: { id: clientId(1), name: 'Cliente 1' }, metrics: metrics(100) }] } as never);
    vi.mocked(getScrapLedgerAnalytics).mockRejectedValue(new Error('unavailable'));
    const result = await generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z'));
    expect(result.counts.suggested).toBe(1);
    expect(result.days[0]?.suggestions[0]?.reasons).toContain('saldo de sucata indisponível');
    expect(result.sources.scrap).toEqual({ status: 'unavailable', generationId: null, publishedAt: null });
  });

  it('marks scrap unavailable when its generation changes during pagination', async () => {
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc) =>
      rpc === 'get_seller_route_profile' ? routeProfile
        : rpc === 'get_scrap_ledger_generation_metadata'
          ? { generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z' }
          : page([customer(1)]));
    vi.mocked(getSalesSignals).mockResolvedValue({ generationId: clientId(90), asOfDate: '2026-11-04',
      signals: [{ client: { id: clientId(1), name: 'Cliente 1' }, metrics: metrics(100) }] } as never);
    vi.mocked(getScrapLedgerAnalytics)
      .mockResolvedValueOnce({ generationId: clientId(91), view: 'balances', page: 1, pageSize: 50,
        totalCount: 51, trendMethod: 'method', rows: [] })
      .mockResolvedValueOnce({ generationId: clientId(92), view: 'balances', page: 2, pageSize: 50,
        totalCount: 51, trendMethod: 'method', rows: [] });

    const result = await generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z'));

    expect(result.sources.scrap).toEqual({ status: 'unavailable', generationId: null, publishedAt: null });
    expect(getScrapLedgerAnalytics).toHaveBeenNthCalledWith(2, expect.anything(), 'balances', '', 2);
  });

  it('uses only completed visits for the 28-day portfolio coverage routine', async () => {
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc) =>
      rpc === 'get_seller_route_profile' ? routeProfile
        : rpc === 'list_seller_client_visit_coverage'
          ? { schemaVersion: 1, sellerId, source: 'api.visits', observedAt: '2026-11-04T01:00:00Z',
            clients: [{ clientId: clientId(1), lastCompletedVisitAt: '2026-09-01T10:00:00-03:00',
              visitId: clientId(80) }] }
          : rpc === 'get_scrap_ledger_generation_metadata'
            ? { generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z' }
            : page([customer(1)]));
    vi.mocked(getSalesSignals).mockResolvedValue({ generationId: clientId(90), asOfDate: '2026-11-04',
      signals: [{ client: { id: clientId(1), name: 'Cliente 1' }, metrics: metrics(5) }] } as never);
    vi.mocked(getScrapLedgerAnalytics).mockResolvedValue({ generationId: clientId(91), view: 'balances',
      page: 1, pageSize: 50, totalCount: 0, trendMethod: 'method', rows: [] });

    const result = await generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z'));

    expect(result.sources.visits).toEqual({ status: 'available', asOfDate: '2026-11-03' });
    expect(result.days[0]?.suggestions[0]).toMatchObject({ clientId: clientId(1),
      coverageState: 'overdue', lastCompletedVisitAt: '2026-09-01T10:00:00-03:00' });
    expect(result.counts).toMatchObject({ coverageDue: 1, coveragePlanned: 1 });
  });

  it('does not generate new routes after the effective offboarding instant', async () => {
    vi.mocked(clientImportRpc).mockResolvedValue({ ...routeProfile, lifecycle: 'inactive',
      offboardingAt: '2026-11-04T14:00:00Z', portfolioState: 'unassigned' });
    await expect(generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z')))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('opens the active version without regenerating or duplicating the week', async () => {
    const persisted = { schemaVersion: 1 as const, proposalId: clientId(70), version: 2,
      status: 'draft' as const, proposal: emptyProposal, createdBy: clientId(71),
      createdAt: '2026-11-04T15:00:00Z', updatedAt: '2026-11-04T15:10:00Z',
      publishedBy: null, publishedAt: null, routeIds: [], predecessorId: null,
      predecessorVersion: null };
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc) =>
      rpc === 'get_weekly_route_proposal_mutation_replay' ? null : persisted);

    await expect(mutateWeeklyProposal({} as never, { ...command,
      operation: 'open_or_generate', idempotencyKey: clientId(72) }, new Date('2026-11-04T16:00:00Z')))
      .resolves.toMatchObject({ outcome: 'existing', record: { proposalId: clientId(70), version: 2 } });
    expect(clientImportRpc).toHaveBeenCalledTimes(2);
    expect(clientImportRpc).toHaveBeenCalledWith(expect.anything(), 'get_active_weekly_route_proposal',
      { p_seller_id: sellerId, p_week_start: command.weekStart });
    expect(listManagedClientSellers).not.toHaveBeenCalled();
  });

  it('regenerates through the public mutation contract without leaking mutation-only fields', async () => {
    vi.mocked(clientImportRpc).mockImplementation(async (_client, rpc, parameters) => {
      if (rpc === 'get_seller_route_profile') return routeProfile;
      if (rpc === 'get_weekly_route_proposal_mutation_replay') return null;
      if (rpc === 'list_seller_client_visit_coverage') return {
        schemaVersion: 1, sellerId, source: 'api.visits', observedAt: '2026-11-04T01:00:00Z',
        clients: [{ clientId: clientId(1), lastCompletedVisitAt: null, visitId: null }],
      };
      if (rpc === 'get_scrap_ledger_generation_metadata') return {
        generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z',
      };
      if (rpc === 'list_management_clients') return page([customer(1)]);
      if (rpc === 'regenerate_weekly_route_proposal') {
        const persistence = (parameters as { p_command: { proposal: typeof emptyProposal } }).p_command;
        return { schemaVersion: 1, proposalId: clientId(70), version: 3, status: 'draft',
          proposal: persistence.proposal, createdBy: clientId(71), createdAt: '2026-11-04T15:00:00Z',
          updatedAt: '2026-11-04T16:00:00Z', publishedBy: null, publishedAt: null, routeIds: [],
          predecessorId: clientId(70), predecessorVersion: 2 };
      }
      throw new Error(`Unexpected RPC: ${rpc}`);
    });
    vi.mocked(getSalesSignals).mockResolvedValue({ generationId: clientId(90), asOfDate: '2026-11-04',
      signals: [{ client: { id: clientId(1), name: 'Cliente 1' }, metrics: metrics(20) }] } as never);
    vi.mocked(getScrapLedgerAnalytics).mockResolvedValue({ generationId: clientId(91), view: 'balances',
      page: 1, pageSize: 50, totalCount: 0, trendMethod: 'method', rows: [] });

    const result = await mutateWeeklyProposal({} as never, { ...command,
      operation: 'regenerate', strategyPreference: 'local', idempotencyKey: clientId(72),
      proposalId: clientId(70), expectedVersion: 2 }, new Date('2026-11-04T16:00:00Z'));

    expect(result).toMatchObject({ outcome: 'regenerated', record: { version: 3,
      proposal: { strategy: { kind: 'local' } } } });
    expect(clientImportRpc).toHaveBeenCalledWith(expect.anything(), 'regenerate_weekly_route_proposal',
      expect.objectContaining({ p_id: clientId(70), p_command: expect.objectContaining({
        expectedVersion: 2, strategyPreference: 'local',
      }) }));
  });

  it('replays a lost regenerate response before reading mutable source data', async () => {
    const persisted = { schemaVersion: 1 as const, proposalId: clientId(70), version: 3,
      status: 'draft' as const, proposal: emptyProposal, createdBy: clientId(71),
      createdAt: '2026-11-04T15:00:00Z', updatedAt: '2026-11-04T16:00:00Z',
      publishedBy: null, publishedAt: null, routeIds: [], predecessorId: clientId(70),
      predecessorVersion: 2 };
    vi.mocked(clientImportRpc).mockResolvedValue(persisted);

    await expect(mutateWeeklyProposal({} as never, { ...command,
      operation: 'regenerate', strategyPreference: 'trip', idempotencyKey: clientId(72),
      proposalId: clientId(70), expectedVersion: 2 }, new Date('2026-11-05T16:00:00Z')))
      .resolves.toMatchObject({ outcome: 'regenerated', record: { proposalId: clientId(70), version: 3 } });
    expect(clientImportRpc).toHaveBeenCalledOnce();
    expect(clientImportRpc).toHaveBeenCalledWith(expect.anything(),
      'get_weekly_route_proposal_mutation_replay', { p_command: {
        schemaVersion: 1, idempotencyKey: clientId(72), operation: 'regenerate',
        targetId: clientId(70), expectedVersion: 2, strategyPreference: 'trip',
        sellerId, weekStart: command.weekStart,
      } });
    expect(listManagedClientSellers).not.toHaveBeenCalled();
    expect(getSalesSignals).not.toHaveBeenCalled();
  });
});
