import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientImportRpc } from '../client-imports/http';
import { getSalesSignals } from '../client-sales/crm';
import { getScrapLedgerAnalytics } from '../scrap-ledger-sync/service';
import { listManagedClientSellers } from '../clients/service';
import { generateWeeklyProposal } from './service';

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
    expect(result.excluded).toContainEqual({ clientId: clientId(2), reason: 'inactive_lost' });
    expect(result.sources).toEqual({ sales: { status: 'available', generationId: clientId(90), asOfDate: '2026-11-04' },
      scrap: { status: 'available', generationId: clientId(91), publishedAt: '2026-11-04T11:00:00Z' } });
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

  it('does not generate new routes after the effective offboarding instant', async () => {
    vi.mocked(clientImportRpc).mockResolvedValue({ ...routeProfile, lifecycle: 'inactive',
      offboardingAt: '2026-11-04T14:00:00Z', portfolioState: 'unassigned' });
    await expect(generateWeeklyProposal({} as never, command, new Date('2026-11-04T15:00:00Z')))
      .rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });
});
