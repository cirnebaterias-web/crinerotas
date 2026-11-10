import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeWeeklyRouteCandidate, proposeWeeklyRoutes } from '@cirne/domain';
import { weeklyRouteCandidateSchema, type PersistedWeeklyRouteProposal } from '@cirne/contracts';
import { WeeklyRouteProposalDashboard } from './weekly-route-proposal-dashboard';
import { WeeklyRoutePlanningMap } from './weekly-route-planning-map';
import { ScrapRequestError, scrapRequest } from '../scrap/scrap-ui';

type HookHarness = { values: unknown[]; cursor: number; effects: Array<() => unknown>; mounted: boolean };
const hooks = vi.hoisted(() => ({ current: null as HookHarness | null }));
// Exercise the actual component callbacks/state transitions without adding a DOM
// dependency. Leaflet gestures and layout remain browser verification concerns.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return { ...react,
    useState<T>(initial: T | (() => T)) {
      const state = hooks.current;
      if (!state) return react.useState(initial);
      const slot = state.cursor++;
      if (!(slot in state.values)) state.values[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [state.values[slot] as T, (value: T | ((previous: T) => T)) => {
        state.values[slot] = typeof value === 'function' ? (value as (previous: T) => T)(state.values[slot] as T) : value;
      }];
    },
    useMemo<T>(factory: () => T, dependencies: unknown[]) {
      return hooks.current ? factory() : react.useMemo(factory, dependencies);
    },
    useEffect(effect: () => unknown, dependencies: unknown[]) {
      if (!hooks.current) return react.useEffect(effect as import('react').EffectCallback, dependencies);
      if (!hooks.current.mounted) hooks.current.effects.push(effect);
    },
  };
});
vi.mock('../scrap/scrap-ui', () => ({ scrapRequest: vi.fn(), ScrapRequestError: class extends Error {} }));

const endpoint = '/api/v1/management/weekly-route-proposals';
const sellerId = '11111111-1111-4111-8111-111111111111';
const clientId = (value: number) => `40000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const origin = { kind: 'base_city' as const, sellerId, city: 'Parnamirim', state: 'RN', ibgeCode: '2403251',
  latitude: -5.91, longitude: -35.26, reference: 'municipal_seat' as const, source: 'IBGE' as const, configVersion: 1 };
const candidates = [1, 2, 3].map((value) => weeklyRouteCandidateSchema.parse({
  clientId: clientId(value), name: `Cliente ${value}`, status: 'active', daysSinceLastPurchase: 5,
  periodicityDays: 30, averageMonthlyVolume: 80, recentVolume3: 100, previousVolume3: 100,
  scrapDebtKg: 30, scrapBalanceState: 'debtor',
  location: value === 2 ? null : { latitude: value === 3 ? -7 : -5.9, longitude: -35.25 },
  hasNavigableAddress: true, visitHistoryStatus: 'available', lastCompletedVisitAt: '2026-08-01T12:00:00-03:00',
}));
const planning = { schemaVersion: 1, sellerId, weekStart: '2026-11-16', origin,
  generatedAt: '2026-11-09T14:00:00-03:00', maxLegDistanceKm: 30,
  candidates: candidates.map((candidate) => {
    const metrics = analyzeWeeklyRouteCandidate(candidate, origin, '2026-11-16');
    return { ...candidate, score: metrics.score, distanceFromBaseKm: metrics.distance,
      cycleDelayDays: metrics.cycleDelayDays, cycleDelayPercent: metrics.cycleDelayPercent,
      purchaseTrend: metrics.purchaseTrend, potential: metrics.potential, reasons: metrics.reasons,
      coverageState: metrics.coverageState, coverageOverdueDays: metrics.coverageOverdueDays, nextVisitDueOn: metrics.nextVisitDueOn };
  }),
  counts: { total: 3, eligible: 3, positioned: 2, inactiveLost: 0 } };
const initialRecord = (): PersistedWeeklyRouteProposal => {
  const proposal = proposeWeeklyRoutes({ weekStart: '2026-11-16', generatedAt: planning.generatedAt, origin,
    candidates: [candidates[0]!] });
  return { schemaVersion: 1, proposalId: '60000000-0000-4000-8000-000000000001', version: 1, status: 'draft',
    proposal: { ...proposal, counts: { ...proposal.counts, coverageDue: 3, coveragePending: 2 } },
    createdBy: sellerId, createdAt: planning.generatedAt, updatedAt: planning.generatedAt,
    publishedBy: null, publishedAt: null, routeIds: [] };
};
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}
async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
function mount() {
  const state: HookHarness = { values: [], cursor: 0, effects: [], mounted: false };
  const render = () => {
    state.cursor = 0; hooks.current = state;
    let tree: ReactNode;
    try { tree = WeeklyRouteProposalDashboard({}); } finally { hooks.current = null; }
    state.mounted = true;
    state.effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  const button = (name: string) => {
    const result = elements(render()).find((item) => item.type === 'button' && renderToStaticMarkup(item).includes(name));
    if (!result) throw new Error(`Button not found: ${name}`);
    return result;
  };
  return { render, button,
    text: () => renderToStaticMarkup(render()),
    async click(name: string) {
      const item = button(name); expect(item.props.disabled).not.toBe(true);
      (item.props.onClick as () => unknown)(); await flush();
    },
    change(label: string, value: string) {
      const parent = elements(render()).find((item) => item.type === 'label' && renderToStaticMarkup(item).includes(label));
      const input = parent && elements(parent).find((item) => item.type === 'input' || item.type === 'select');
      if (!input) throw new Error(`Input not found: ${label}`);
      (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    },
  };
}

describe('weekly route dashboard interactions', () => {
  let persisted: PersistedWeeklyRouteProposal;
  let conflict: boolean;
  const request = vi.mocked(scrapRequest);
  beforeEach(() => {
    persisted = initialRecord(); conflict = false;
    request.mockReset();
    request.mockImplementation(async (path, options) => {
      if (path === '/api/v1/clients/sellers') return { schemaVersion: 1,
        sellers: [{ id: sellerId, displayName: 'Vendedor', email: 'seller@example.invalid' }] };
      if (path.startsWith(`${endpoint}?`)) return planning;
      if (path.startsWith('/api/v1/clients?')) return { schemaVersion: 1, query: 'Cliente',
        clients: candidates.slice(1).map((candidate) => ({ schemaVersion: 1, id: candidate.clientId,
          externalReference: candidate.clientId, name: candidate.name, address: 'Endereço navegável',
          latitude: candidate.location?.latitude ?? null, longitude: candidate.location?.longitude ?? null,
          portfolioReference: 'Carteira', sellerId, sellerEmail: 'seller@example.invalid', status: 'active', version: 1 })),
        pagination: { page: 1, pageSize: 25, totalCount: 2, totalPages: 1, hasPrevious: false, hasNext: false } };
      if (options?.method === 'POST') return { schemaVersion: 1, outcome: 'existing', record: persisted };
      if (options?.method === 'PATCH') {
        if (conflict) throw new ScrapRequestError('Conflito: outra sessão salvou uma versão mais recente.', 409, 'VERSION_CONFLICT');
        const body = JSON.parse(String(options.body));
        persisted = { ...persisted, version: persisted.version + 1,
          proposal: { ...persisted.proposal, days: body.days ?? persisted.proposal.days },
          status: body.decision === 'publish' ? 'published' : 'draft' };
        return persisted;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });
  afterEach(() => { hooks.current = null; });

  async function open() {
    const app = mount(); app.render(); await flush();
    app.change('Segunda-feira da semana', '2026-11-16');
    await app.click('Abrir ou criar sugestão');
    return app;
  }

  it('preserves real manual-add coverage, dirty edits on conflict, then saves and publishes the returned version', async () => {
    const app = await open();
    app.change('Buscar por nome', 'Cliente'); await app.click('Pesquisar carteira');
    // The first result is the client with a known overdue visit and no coordinates.
    await app.click('>Adicionar</button>');
    expect(app.text()).toContain('localização pendente');
    expect(app.text()).toContain('Há alterações locais não salvas');
    expect(app.button('Publicar semana').props.disabled).toBe(true);
    conflict = true; await app.click('Salvar ordem revisada');
    expect(app.text()).toContain('outra sessão salvou');
    expect(app.text()).toContain('Há alterações locais não salvas');
    const failedSave = [...request.mock.calls].reverse().find(([, options]) => options?.method === 'PATCH');
    const submitted = JSON.parse(String(failedSave?.[1]?.body)).days.flatMap((day: { suggestions: unknown[] }) => day.suggestions);
    expect(submitted).toContainEqual(expect.objectContaining({ clientId: clientId(2),
      lastCompletedVisitAt: candidates[1]!.lastCompletedVisitAt, coverageState: 'overdue',
      nextVisitDueOn: planning.candidates[1]!.nextVisitDueOn,
      coverageOverdueDays: planning.candidates[1]!.coverageOverdueDays, locationPending: true }));
    conflict = false; await app.click('Salvar ordem revisada');
    expect(app.text()).not.toContain('Há alterações locais não salvas');
    expect(app.button('Publicar semana').props.disabled).toBe(false);
    await app.click('Publicar semana');
    const lastCall = request.mock.calls.at(-1)!;
    expect(JSON.parse(String(lastCall[1]?.body))).toMatchObject({ decision: 'publish', expectedVersion: 2 });
  });

  it('adds a list-selected unpositioned client and explicitly reports a distant client still pending', async () => {
    const app = await open();
    const map = elements(app.render()).find((item) => item.type === WeeklyRoutePlanningMap)!;
    (map.props.onSelection as (ids: string[]) => void)([clientId(2), clientId(3)]);
    await app.click('Adicionar seleção ao rascunho');
    expect(app.text()).toContain('1 com localização pendente');
    expect(app.text()).toContain('1 por distância');
    await app.click('Salvar ordem revisada');
    const body = JSON.parse(String(request.mock.calls.at(-1)![1]?.body));
    const selected = body.days.flatMap((day: { suggestions: unknown[] }) => day.suggestions);
    expect(selected).toContainEqual(expect.objectContaining({ clientId: clientId(2), locationPending: true, coverageState: 'overdue' }));
    expect(selected).not.toContainEqual(expect.objectContaining({ clientId: clientId(3) }));
  });

  it('submits the selected strategy preference and permits explicitly discarding local edits', async () => {
    const app = mount(); app.render(); await flush();
    app.change('Preferência de estratégia', 'trip'); await app.click('Abrir ou criar sugestão');
    const post = request.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ strategyPreference: 'trip' });
    await app.click('Remover');
    expect(app.text()).toContain('Há alterações locais não salvas');
    await app.click('Descartar alterações locais');
    expect(app.text()).not.toContain('Há alterações locais não salvas');
    expect(app.text()).toContain('1 clientes na semana');
  });

  it('keeps the previous known position when an unpositioned manual stop precedes a distant stop', async () => {
    const app = await open();
    app.change('Buscar por nome', 'Cliente'); await app.click('Pesquisar carteira');
    await app.click('>Adicionar</button>');
    await app.click('>Adicionar</button>');
    expect(app.text()).toContain('possui trecho acima de 30 km');
    expect(app.button('Salvar ordem revisada').props.disabled).toBe(true);
    expect(app.button('Publicar semana').props.disabled).toBe(true);
  });

  it('shows the selected region and identifies every pending client with its reason', async () => {
    const base = initialRecord();
    persisted = { ...base, proposal: { ...base.proposal,
      strategy: { kind: 'trip', region: 'Cluster a 110 km de Parnamirim/RN', distanceFromBaseKm: 110 },
      excluded: [{ clientId: clientId(3), reason: 'weekly_strategy_mismatch' }],
      counts: { ...base.proposal.counts, needsReview: 1 } } };
    const app = await open();
    expect(app.text()).toContain('Semana de viagem');
    expect(app.text()).toContain('Cluster a 110 km de Parnamirim/RN');
    expect(app.text()).toContain('Cliente 3');
    expect(app.text()).toContain('local/viagem escolhida');
  });
});
