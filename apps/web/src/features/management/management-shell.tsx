'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { MeResponse } from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';
import { sellerClient } from '@/lib/seller-client';
import { visibleManagementNavigationItems } from './management-navigation-items';

function ManagementNavigation({ identity, onNavigate }: { identity: MeResponse | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  const visible = useMemo(() => visibleManagementNavigationItems(identity), [identity]);
  const activeHref = visible.filter((item) => (
    pathname === item.href || pathname.startsWith(`${item.href}/`)
  )).sort((left, right) => right.href.length - left.href.length)[0]?.href;
  return <nav className="management-nav" aria-label="Navegação da gestão">
    <p>Operação</p>
    {visible.map((item) => {
      const active = item.href === activeHref;
      return <a key={item.href} href={item.href} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
        <span aria-hidden="true">{active ? '●' : '○'}</span>{item.label}
      </a>;
    })}
  </nav>;
}

export function ManagementShell({ children, initialIdentity }: { children: ReactNode; initialIdentity: MeResponse | null }) {
  const [identity, setIdentity] = useState<MeResponse | null>(initialIdentity);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialIdentity) return;
    const controller = new AbortController();
    void sellerClient.identity(controller.signal).then(setIdentity).catch(() => undefined);
    return () => controller.abort();
  }, [initialIdentity]);

  useEffect(() => {
    if (!drawerOpen) return;
    window.setTimeout(() => drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setDrawerOpen(false);
      window.setTimeout(() => menuButtonRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen]);

  return <div className="seller-app management-shell">
    <a className="management-skip" href="#management-content">Pular para o conteúdo</a>
    <aside className="management-sidebar">
      <div className="management-brand"><Brand /><small>Central do gestor</small></div>
      <ManagementNavigation identity={identity} />
      <a className="management-home-link" href="/home">Voltar ao início</a>
    </aside>
    <header className="management-mobile-header">
      <Brand />
      <button ref={menuButtonRef} type="button" aria-expanded={drawerOpen} aria-controls="management-drawer" onClick={() => setDrawerOpen(!drawerOpen)}>
        Menu
      </button>
      {drawerOpen && <div ref={drawerRef} className="management-drawer" id="management-drawer" role="region" aria-label="Menu da gestão">
        <button type="button" className="management-drawer-close" onClick={() => { setDrawerOpen(false); menuButtonRef.current?.focus(); }}>Fechar ×</button>
        <ManagementNavigation identity={identity} onNavigate={() => setDrawerOpen(false)} />
        <a className="management-home-link" href="/home">Voltar ao início</a>
      </div>}
    </header>
    <div className="management-content" id="management-content">{children}</div>
  </div>;
}
