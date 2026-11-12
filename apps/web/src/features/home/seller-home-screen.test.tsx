import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { SellerHomeScreen } from './seller-home-screen';
import { sellerClient } from '@/lib/seller-client';

type HookHarness = {
  values: unknown[];
  cursor: number;
  effects: Array<() => unknown>;
  mounted: boolean;
};

type Element = ReactElement<Record<string, unknown>>;

const hooks = vi.hoisted(() => ({ current: null as HookHarness | null }));

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState<T>(initial: T | (() => T)) {
      const state = hooks.current;
      if (!state) return react.useState(initial);
      const slot = state.cursor++;
      if (!(slot in state.values)) {
        state.values[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      return [state.values[slot] as T, (value: T | ((previous: T) => T)) => {
        state.values[slot] = typeof value === 'function'
          ? (value as (previous: T) => T)(state.values[slot] as T)
          : value;
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
      if (!hooks.current) return react.useEffect(effect as import('react').EffectCallback, dependencies);
      if (!hooks.current.mounted) hooks.current.effects.push(effect);
    },
  };
});

vi.mock('@/lib/seller-client', () => ({
  sellerClient: { identity: vi.fn(), logout: vi.fn() },
}));

vi.mock('@/features/scrap/scrap-ui', () => ({
  ScrapShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/offline/standalone-scrap', () => ({
  StandaloneScrapScheduleStore: class {
    close() {}
    async listSchedules() { return []; }
    async synchronize() { return []; }
  },
}));

vi.mock('@/lib/offline/access-revocation', () => ({
  observeLocalAccessRevocation: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/offline/service', () => ({
  OfflineFoundationService: class {
    close() {}
    async revokeLocalAccess() {}
  },
}));

vi.mock('@/components/ui', () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/feedback', () => ({
  StatusBanner: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
}));

function elements(node: ReactNode): Element[] {
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...Children.toArray(element.props.children as ReactNode).flatMap(elements)];
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function mount() {
  const state: HookHarness = { values: [], cursor: 0, effects: [], mounted: false };
  const render = () => {
    state.cursor = 0;
    hooks.current = state;
    let tree: ReactNode;
    try {
      tree = SellerHomeScreen();
    } finally {
      hooks.current = null;
    }
    state.mounted = true;
    state.effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  return { render };
}

const identity: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Vendedor sintético',
  status: 'active',
  roles: ['seller'],
  capabilities: [
    'route.read_self',
    'scrap.schedule_self',
    'scrap.collect_self',
    'scrap.execute_pickups',
    'scrap.read_operations',
    'clients.import',
    'identity.manage',
  ],
  scopeIds: [],
};

describe('SellerHomeScreen external shortcuts', () => {
  beforeEach(() => {
    vi.mocked(sellerClient.identity).mockReset();
    vi.mocked(sellerClient.identity).mockResolvedValue(identity);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    hooks.current = null;
    vi.unstubAllGlobals();
  });

  it('hides shortcuts before identity and appends secure external links after every internal operation', async () => {
    const app = mount();
    const initialMarkup = renderToStaticMarkup(app.render());
    expect(initialMarkup).not.toContain('Catálogo de baterias');
    expect(initialMarkup).not.toContain('Orbis');

    await flush();
    const tree = elements(app.render());
    const operationList = tree.find((element) => element.props['aria-label'] === 'Operações disponíveis');
    expect(operationList).toBeDefined();

    const links = elements(operationList).filter((element) => element.type === 'a');
    const catalog = links.at(-2);
    const orbis = links.at(-1);

    expect(renderToStaticMarkup(catalog!)).toContain('Catálogo de baterias');
    expect(catalog?.props).toMatchObject({
      className: 'seller-task-card',
      href: 'https://catalogo.bateriaspioneiro.com.br/',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(renderToStaticMarkup(orbis!)).toContain('Orbis');
    expect(orbis?.props).toMatchObject({
      className: 'seller-task-card',
      href: 'https://apporbis.lovable.app/auth',
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    expect(links.slice(0, -2)).not.toContain(catalog);
    expect(links.slice(0, -2)).not.toContain(orbis);
  });
});
