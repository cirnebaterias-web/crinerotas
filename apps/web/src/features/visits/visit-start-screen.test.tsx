import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalVisitDraft } from '@cirne/contracts';
import type { VisitStartView } from './visit-start-controller';
import { VisitStartScreen } from './visit-start-screen';
import { VisitSalesStep } from './sales/visit-sales-step';

type Harness = { values: unknown[]; cursor: number; effects: Array<() => unknown>; view: VisitStartView; step: string };
const hooks = vi.hoisted(() => ({ current: null as Harness | null }));
vi.mock('@/features/auth/brand', () => ({ Brand: () => <span>Cirne Rotas</span> }));
vi.mock('@/lib/offline/service', () => ({ OfflineFoundationService: class {} }));
vi.mock('@/lib/offline/access-revocation', () => ({ observeLocalAccessRevocation: vi.fn() }));
vi.mock('./scrap/visit-scrap-step', () => ({ VisitScrapStep: () => <div>Sucata</div> }));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return { ...react,
    useState<T>(initial: T | (() => T)) {
      const state = hooks.current;
      if (!state) return react.useState(initial);
      const slot = state.cursor++;
      if (!(slot in state.values)) state.values[slot] = initial && typeof initial === 'object' && 'requiresLogin' in initial
        ? state.view : initial === 'start' ? state.step : typeof initial === 'function' ? (initial as () => T)() : initial;
      return [state.values[slot] as T, (value: T | ((previous: T) => T)) => {
        state.values[slot] = typeof value === 'function' ? (value as (previous: T) => T)(state.values[slot] as T) : value;
      }];
    },
    useRef<T>(initial: T) {
      const state = hooks.current;
      if (!state) return react.useRef(initial);
      const slot = state.cursor++;
      if (!(slot in state.values)) state.values[slot] = { current: initial };
      return state.values[slot] as { current: T };
    },
    useEffect(effect: () => unknown, dependencies: unknown[]) {
      const state = hooks.current;
      if (!state) return react.useEffect(effect as import('react').EffectCallback, dependencies);
      // Controller persistence has its own tests; run only the screen's navigation effects here.
      if (dependencies.length === 1 && typeof dependencies[0] === 'string') return;
      state.effects.push(effect);
    },
  };
});

const stamp = '2026-11-12T12:00:00.000Z';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(): LocalVisitDraft {
  return { schemaVersion: 1, userId: id, deviceId: id, offlineId: id, routeVersionStopId: id,
    currentStep: 'sales', localStatus: 'draft', persistenceState: 'saved_on_device', updatedAt: stamp,
    stock: { heliarQuantity: 0, mouraQuantity: 0, ownLines: [], competitorLines: [],
      completedOwnBrands: ['Heliar', 'América', 'Durex', 'ACDelco'], eventId: id,
      deviceSavedAt: stamp, collectionCompletedAt: stamp, persistenceState: 'saved_on_device' },
    prices: { availability: 'unavailable', unavailableReasonId: id, eventId: id, deviceSavedAt: stamp, persistenceState: 'saved_on_device' },
    commercialActions: { ownAcknowledgements: [], competitor: { availability: 'not_identified' },
      eventId: id, deviceSavedAt: stamp, persistenceState: 'saved_on_device' },
    scrap: { availability: 'none', eventId: id, deviceSavedAt: stamp, persistenceState: 'saved_on_device' },
  };
}
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}
function mount(draft = fixture(), step = 'start') {
  const location = { href: `https://example.invalid/visit/${id}?step=${step}` };
  vi.stubGlobal('window', { location, history: {
    replaceState(_state: unknown, _unused: string, url: URL) { location.href = String(url); },
    pushState(_state: unknown, _unused: string, url: URL) { location.href = String(url); },
  } });
  const view: VisitStartView = { state: 'ready', draft, busy: false, requiresLogin: false, message: '',
    commercialActions: [], scrapPoints: [], evidence: [], attachments: [1, 2, 3].map((index) => ({
      schemaVersion: 1, userId: id, deviceId: id, offlineId: String(index), visitOfflineId: id,
      purpose: 'stock_evidence', contentType: 'image/jpeg', byteSize: 10, checksum: 'a'.repeat(64),
      capturedAt: stamp, status: 'pending', fileName: `photo-${index}.jpg`, width: 10, height: 10, blob: new Blob(),
    })) };
  const state: Harness = { values: [], cursor: 0, effects: [], view, step };
  const render = () => {
    state.cursor = 0; hooks.current = state;
    let tree: ReactNode;
    try { tree = VisitStartScreen({ offlineId: id }); } finally { hooks.current = null; }
    state.effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  return { render, text: () => renderToStaticMarkup(render()) };
}
afterEach(() => { hooks.current = null; vi.unstubAllGlobals(); });

describe('VisitStartScreen sales task', () => {
  it('places sales between commercial actions and scrap and keeps scrap locked without a declaration', () => {
    const app = mount();
    const tasks = elements(app.render()).filter((element) => element.type === 'button' && element.props.className === 'seller-task-card');
    const labels = tasks.map((element) => renderToStaticMarkup(element));
    expect(labels).toHaveLength(5);
    expect(labels[2]).toContain('Ações comerciais');
    expect(labels[3]).toContain('Informe de venda na visita');
    expect(labels[4]).toContain('Sucata');
    expect(tasks[3]!.props.disabled).toBe(false);
    expect(tasks[4]!.props.disabled).toBe(true);
    expect(labels[3]).not.toContain('Salvo no aparelho');
  });

  it('shows a saved declaration as completed and unlocks scrap even when quantities are zero', () => {
    const draft = fixture();
    draft.sales = { heliarQuantity: 0, americaQuantity: 0, stradaDurexQuantity: 0, version: 1,
      eventId: id, deviceSavedAt: stamp, persistenceState: 'saved_on_device' };
    const app = mount(draft);
    const tasks = elements(app.render()).filter((element) => element.type === 'button' && element.props.className === 'seller-task-card');
    expect(tasks[3]!.props['data-state']).toBe('completed');
    expect(renderToStaticMarkup(tasks[3]!)).toContain('Salvo no aparelho');
    expect(tasks[4]!.props.disabled).toBe(false);
  });

  it('redirects a legacy in-progress review with saved scrap to sales and offers no checkout', () => {
    const app = mount(fixture(), 'review');
    expect(app.text()).not.toContain('Encerrar visita');
    const tree = elements(app.render());
    expect(tree.some((element) => element.type === VisitSalesStep)).toBe(true);
    expect(window.location.href).toContain('step=sales');
  });

  it('keeps a closed historical visit without a declaration closed', () => {
    const draft = { ...fixture(), localStatus: 'completed' as const, stock: undefined, prices: undefined,
      commercialActions: undefined, scrap: undefined };
    const app = mount(draft, 'review');
    app.render();
    expect(app.text()).toContain('VISITA ENCERRADA');
    expect(app.text()).not.toContain('Salvar informe de venda');
    expect(window.location.href).toContain('step=complete');
  });
});
