import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalVisitDraft, StockInput } from '@cirne/contracts';
import { VisitStockStep } from './visit-stock-step';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef: () => ({ current: null }), useEffect: () => {},
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
afterEach(() => { hooks.values = []; hooks.cursor = 0; vi.unstubAllGlobals(); });

it('locks editing and brand navigation while the captured own stock is committing', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const draft: LocalVisitDraft = { schemaVersion: 1, userId: id, deviceId: id, offlineId: id,
    routeVersionStopId: id, currentStep: 'start', localStatus: 'draft',
    persistenceState: 'saved_on_device', updatedAt: '2026-11-12T12:00:00Z' };
  vi.stubGlobal('window', { location: { href: 'https://example.invalid/visit/test?step=stock' },
    history: { replaceState() {} } });
  let finish!: () => void;
  const onSave = vi.fn<(snapshot: StockInput) => Promise<void>>(() => new Promise<void>((resolve) => { finish = resolve; }));
  const dirty = vi.fn();
  const render = () => { hooks.cursor = 0; return elements(VisitStockStep({ draft, onSave, onContinue() {}, onDirtyChange: dirty })); };
  const overview = render();
  (overview.find((element) => element.props['aria-label'] === 'Heliar: 0 unidades. Abrir modelos')!.props.onClick as () => void)();
  const detail = render();
  (detail.find((element) => element.props['aria-label'] === 'Aumentar HG38JD 24-320')!.props.onClick as () => void)();
  const form = render().find((element) => element.type === 'form')!;
  const saving = (form.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  const pending = render();
  expect(pending.find((element) => element.props.className === 'seller-stock-save-fields')!.props.disabled).toBe(true);
  expect(pending.find((element) => element.props.className === 'seller-stock-back')!.props.disabled).toBe(true);
  expect(onSave.mock.calls[0]![0].ownLines).toMatchObject([{ quantity: 1, model: 'HG38JD 24-320' }]);
  finish(); await saving;
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(render().some((element) => element.props.className === 'seller-stock-overview')).toBe(true);
});
