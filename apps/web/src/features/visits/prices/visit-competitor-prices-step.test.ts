import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalCompetitorPriceParameterSet, LocalVisitDraft } from '@cirne/contracts';
import { findCatalogPriceRow, suggestedTechnologyId } from './visit-competitor-prices-step';
import { VisitCompetitorPricesStep } from './visit-competitor-prices-step';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef: <T>(initial: T) => ({ current: initial }), useEffect: () => {}, useMemo: <T>(factory: () => T) => factory(),
  useState<T>(initial: T | (() => T)) {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[slot] as T, (value: T | ((previous: T) => T)) => {
      hooks.values[slot] = typeof value === 'function' ? (value as (previous: T) => T)(hooks.values[slot] as T) : value;
    }];
  },
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}

const draft = { schemaVersion: 1, userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222', offlineId: '33333333-3333-4333-8333-333333333333',
  routeVersionStopId: '44444444-4444-4444-8444-444444444444', currentStep: 'prices', localStatus: 'draft',
  persistenceState: 'saved_on_device', updatedAt: '2026-11-13T12:00:00Z' } as LocalVisitDraft;
const parameters = { values: {
  competitors: [{ id: 'heliar-id', code: 'heliar', label: 'Heliar' },
    { id: 'competitor-id', code: 'competitor', label: 'Concorrente Teste' }],
  technologies: [{ id: 'agm-id', code: 'agm', label: 'AGM' }],
  conditions: [{ id: 'cash-id', code: 'cash', label: 'À vista' }], unavailableReasons: [],
} } as unknown as LocalCompetitorPriceParameterSet;

function mount() {
  const render = () => { hooks.cursor = 0; return VisitCompetitorPricesStep({ draft, parameters, onSave: vi.fn() }); };
  return { render, elements: () => elements(render()) };
}

afterEach(() => { hooks.values = []; hooks.cursor = 0; vi.unstubAllGlobals(); });

describe('findCatalogPriceRow', () => {
  const rows = [
    { rowId: 'first', productCode: 'SKU-001', modelOrAmperage: 'MODELO REPETIDO' },
    { rowId: 'second', productCode: 'SKU-002', modelOrAmperage: 'MODELO REPETIDO' },
    { rowId: 'legacy', modelOrAmperage: 'MODELO LEGADO' },
  ];

  it('keeps catalog products with the same model independent by product code', () => {
    expect(findCatalogPriceRow(rows, 'SKU-001', 'MODELO REPETIDO')?.rowId).toBe('first');
    expect(findCatalogPriceRow(rows, 'SKU-002', 'MODELO REPETIDO')?.rowId).toBe('second');
  });

  it('uses the model fallback only for rows without a product code', () => {
    expect(findCatalogPriceRow(rows, 'SKU-LEGACY', 'modelo legado')?.rowId).toBe('legacy');
    expect(findCatalogPriceRow(rows, 'SKU-003', 'MODELO REPETIDO')).toBeUndefined();
  });

  it('never selects the first published technology when the model has no matching technology', () => {
    const technologies = [
      { id: 'first', code: 'synthetic', label: 'Tecnologia sintética' },
      { id: 'agm', code: 'agm', label: 'AGM' },
    ];
    expect(suggestedTechnologyId('Bateria comum', technologies)).toBe('');
    expect(suggestedTechnologyId('Modelo AGM 70 Ah', technologies)).toBe('agm');
  });
});

describe('VisitCompetitorPricesStep accessible validation', () => {
  it('keeps own technology and condition errors inside uniquely described controls', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/visit/test?step=prices', search: '?step=prices' },
      history: { pushState() {} }, addEventListener() {}, removeEventListener() {} });
    const app = mount();
    (app.elements().find((element) => element.props['aria-label'] === 'Heliar: 0 preços. Abrir produtos')!.props.onClick as () => void)();
    const price = app.elements().find((element) => element.type === 'input'
      && element.props['aria-label'] === 'Preço de venda de HG38JD 24-320')!;
    (price.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '529' } });
    const save = app.elements().find((element) => element.type === 'button'
      && renderToStaticMarkup(element).includes('Salvar Heliar'))!;
    (save.props.onClick as () => void)();
    const tree = app.elements();
    for (const id of ['catalog-technology-502000030', 'catalog-condition-502000030']) {
      const control = tree.find((element) => element.type === 'select' && element.props.id === id)!;
      const errorId = `${id}-error`;
      expect(control.props).toMatchObject({ 'aria-invalid': true, 'aria-describedby': errorId });
      expect(tree.find((element) => element.props.id === errorId)).toBeDefined();
    }
  });

  it('associates competitor technology and condition errors with distinct controls', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/visit/test?step=prices', search: '?step=prices' },
      history: { pushState() {} }, addEventListener() {}, removeEventListener() {} });
    const app = mount();
    const continueButton = app.elements().find((element) => element.type === 'button'
      && renderToStaticMarkup(element).includes('Continuar para preços da concorrência'))!;
    (continueButton.props.onClick as () => void)();
    const competitor = app.elements().find((element) => element.type === 'button'
      && renderToStaticMarkup(element).includes('Concorrente Teste'))!;
    (competitor.props.onClick as () => void)();
    const tree = app.elements();
    const model = tree.find((element) => element.type === 'input' && element.props.id === 'price-new-row-1-modelOrAmperage')!;
    const price = tree.find((element) => element.type === 'input' && element.props.id === 'price-new-row-1-priceBrl')!;
    (model.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '60 Ah' } });
    (price.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '399' } });
    const review = app.elements().find((element) => element.type === 'button'
      && renderToStaticMarkup(element).includes('Revisar preços informados'))!;
    (review.props.onClick as () => void)();
    const invalidTree = app.elements();
    for (const field of ['technologyId', 'conditionId']) {
      const id = `price-new-row-1-${field}`;
      const control = invalidTree.find((element) => element.type === 'select' && element.props.id === id)!;
      expect(control.props).toMatchObject({ 'aria-invalid': true, 'aria-describedby': `${id}-error` });
      expect(invalidTree.find((element) => element.props.id === `${id}-error`)).toBeDefined();
    }
  });
});
