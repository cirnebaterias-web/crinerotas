import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalVisitDraft, VisitSalesInput } from '@cirne/contracts';
import { VisitSalesStep } from './visit-sales-step';

const hooks = vi.hoisted(() => ({ current: null as { values: unknown[]; cursor: number } | null }));
// Match the existing interaction harness: exercise callbacks and state without a DOM dependency.
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
    useRef<T>(initial: T) { return hooks.current ? { current: initial } : react.useRef(initial); },
    useEffect(effect: () => unknown, dependencies: unknown[]) {
      if (!hooks.current) return react.useEffect(effect as import('react').EffectCallback, dependencies);
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}
const draft = { offlineId: '11111111-1111-4111-8111-111111111111' } as LocalVisitDraft;

function mount(onSave: (values: VisitSalesInput, expectedVersion: number) => Promise<void>, initial = draft) {
  const state = { values: [] as unknown[], cursor: 0 };
  let currentDraft = initial;
  const dirty = vi.fn();
  const render = () => {
    state.cursor = 0; hooks.current = state;
    try { return VisitSalesStep({ draft: currentDraft, onSave, onDirtyChange: dirty }); }
    finally { hooks.current = null; }
  };
  const input = (name: string) => elements(render()).find((element) => element.type === 'input' && element.props.id === `sales-${name}`)!;
  return { render, dirty, input,
    updateDraft(next: LocalVisitDraft) { currentDraft = next; },
    text: () => renderToStaticMarkup(render()),
    change(name: string, value: string) {
      (input(name).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    },
    submit() {
      const form = elements(render()).find((element) => element.type === 'form')!;
      return (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
    },
  };
}

const names = ['heliarQuantity', 'americaQuantity', 'stradaDurexQuantity'];
afterEach(() => { hooks.current = null; });

describe('VisitSalesStep', () => {
  it('starts exactly three required fields empty with numeric keyboards and explicit zero instructions', () => {
    const app = mount(vi.fn());
    expect(elements(app.render()).filter((element) => element.type === 'input')).toHaveLength(3);
    for (const name of names) expect(app.input(name).props).toMatchObject({ value: '', required: true, inputMode: 'numeric' });
    expect(app.text()).toContain('Preencha 0 quando não houve venda');
  });

  it.each(['', '-1', '1.5', 'abc', '1e2', '2147483648'])('rejects %j with a field-associated error and preserves valid other fields', async (invalid) => {
    const save = vi.fn(); const app = mount(save);
    names.forEach((name) => app.change(name, '0'));
    app.change('americaQuantity', invalid);
    await app.submit();
    expect(save).not.toHaveBeenCalled();
    expect(app.input('americaQuantity').props['aria-invalid']).toBe(true);
    expect(app.input('americaQuantity').props['aria-describedby']).toContain('sales-americaQuantity-error');
    expect(app.input('heliarQuantity').props['aria-invalid']).toBe(false);
    expect(app.input('heliarQuantity').props.value).toBe('0');
  });

  it('saves three explicit zeros and only clears dirty state after the save resolves', async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const app = mount(save); names.forEach((name) => app.change(name, '0'));
    const pending = app.submit();
    expect(save).toHaveBeenCalledWith({ heliarQuantity: 0, americaQuantity: 0, stradaDurexQuantity: 0 }, 0);
    expect(app.text()).toContain('Salvando no aparelho');
    expect(app.input('heliarQuantity').props.disabled).toBe(true);
    expect(app.dirty).not.toHaveBeenCalledWith(false);
    resolve(); await pending;
    expect(app.dirty).toHaveBeenLastCalledWith(false);
  });

  it('keeps quantities editable and shows no false success when local persistence fails', async () => {
    const app = mount(vi.fn().mockRejectedValue(new Error('QUOTA')));
    names.forEach((name, index) => app.change(name, String(index + 2)));
    await app.submit();
    expect(app.text()).toContain('Não foi possível salvar no aparelho');
    expect(app.text()).not.toContain('Salvo no aparelho');
    expect(app.input('americaQuantity').props).toMatchObject({ value: '3', disabled: false });
    expect(app.dirty).not.toHaveBeenCalledWith(false);
  });

  it('reopens persisted quantities including zero and submits an edit', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const app = mount(save, { ...draft, sales: { heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 7,
      version: 1, eventId: draft.offlineId, deviceSavedAt: '2026-11-12T12:00:00Z', persistenceState: 'saved_on_device' } });
    expect(app.input('heliarQuantity').props.value).toBe('0');
    expect(app.input('stradaDurexQuantity').props.value).toBe('7');
    app.change('americaQuantity', '4'); await app.submit();
    expect(save).toHaveBeenCalledWith({ heliarQuantity: 0, americaQuantity: 4, stradaDurexQuantity: 7 }, 1);
  });

  it('preserves intentional edits and blocks saving when refreshed props contain a newer declaration', async () => {
    const saved = { heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 7,
      version: 1, eventId: draft.offlineId, deviceSavedAt: '2026-11-12T12:00:00Z', persistenceState: 'saved_on_device' as const };
    const save = vi.fn();
    const app = mount(save, { ...draft, sales: saved });
    app.change('americaQuantity', '4');
    app.updateDraft({ ...draft, sales: { ...saved, americaQuantity: 12, version: 2 } });
    expect(app.input('americaQuantity').props.value).toBe('4');
    expect(app.text()).toContain('Volte às tarefas e reabra o informe');
    expect(elements(app.render()).find((element) => element.type === 'button')!.props.disabled).toBe(true);
    await app.submit();
    expect(save).not.toHaveBeenCalled();
    expect(app.dirty).not.toHaveBeenCalledWith(false);
  });

  it('preserves edits and requests reopening after a transactional version conflict', async () => {
    const conflict = Object.assign(new Error('A declaração foi alterada.'), { code: 'VERSION_CONFLICT' });
    const save = vi.fn().mockRejectedValue(conflict);
    const app = mount(save);
    names.forEach((name) => app.change(name, '3'));
    await app.submit();
    expect(save).toHaveBeenCalledWith({ heliarQuantity: 3, americaQuantity: 3, stradaDurexQuantity: 3 }, 0);
    expect(app.input('americaQuantity').props.value).toBe('3');
    expect(app.text()).toContain('reabra o informe');
    await app.submit();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
