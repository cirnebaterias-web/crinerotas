'use client';

import { useEffect, useState } from 'react';
import type { MeResponse } from '@cirne/contracts';
import { sellerClient } from '@/lib/seller-client';
import { ScrapShell } from '@/features/scrap/scrap-ui';
import { StandaloneScrapScheduleStore } from '@/lib/offline/standalone-scrap';
import type { LocalStandaloneScrapSchedule } from '@/lib/offline/database';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';

export function SellerHomeScreen() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [error, setError] = useState('');
  const [schedules, setSchedules] = useState<LocalStandaloneScrapSchedule[]>([]);
  useEffect(() => {
    let active = true;
    const stop = observeLocalAccessRevocation(() => { active = false; setIdentity(null); setError('Entre novamente para acessar sua operação.'); });
    void sellerClient.identity().then((user) => { if (active) setIdentity(user); }).catch(() => { if (active) setError('Entre novamente para acessar sua operação.'); });
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => {
    const store = new StandaloneScrapScheduleStore(); let active = true;
    async function resume() {
      if (!active) return;
      try { const saved = await store.listSchedules(); if (active) setSchedules(saved); const synchronized = await store.synchronize(); if (active) setSchedules(synchronized); }
      catch { /* Authenticated operational entry still displays its own access state. */ }
    }
    const online = () => { void resume(); };
    const stop = observeLocalAccessRevocation(() => { active = false; setSchedules([]); setIdentity(null); setError('Entre novamente para acessar sua operação.'); });
    void resume(); window.addEventListener('online', online);
    return () => { active = false; stop(); window.removeEventListener('online', online); store.close(); };
  }, []);
  return <ScrapShell><p className="seller-kicker">CIRNE ROTAS</p><h1>Seu dia de trabalho.</h1>{identity && <p className="seller-muted">{identity.displayName}</p>}
    {error && <p className="seller-notice" role="alert">{error} <a href="/login">Entrar</a></p>}
    {!identity && !error && <p role="status">Validando seu acesso…</p>}
    {identity && <section className="seller-task-list" aria-label="Operações disponíveis">
      {identity.capabilities.includes('route.read_self') && <a className="seller-task-card" href="/route"><span><strong>Rota</strong><small>Paradas e tarefas das visitas</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('scrap.schedule_self') && <a className="seller-task-card" href="/scrap/schedule"><span><strong>Agendar coleta de sucata</strong><small>Agende por contato com o cliente, mesmo fora da rota</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('scrap.read_operations') && <a className="seller-task-card" href="/management/scrap"><span><strong>Sucata · Gestão e logística</strong><small>Agenda, custódia e recebimento</small></span><span aria-hidden="true">→</span></a>}
      {identity.roles.includes('manager') && identity.capabilities.includes('route.read_scoped') && <a className="seller-task-card" href="/management/pilot"><span><strong>Métricas do piloto</strong><small>Resultados provisórios e fontes ainda pendentes</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('clients.import') && <a className="seller-task-card" href="/management/clients"><span><strong>Base de clientes</strong><small>Validar e importar planilha Excel</small></span><span aria-hidden="true">→</span></a>}
    </section>}
    {schedules.some((record) => record.status !== 'synced') && <section className="seller-progress" aria-label="Agendamentos de sucata pendentes"><h2>Agendamentos salvos no aparelho</h2><p role="status">{schedules.filter((record) => record.status === 'pending').length} aguardando envio · {schedules.filter((record) => record.status === 'action_required').length} requerem conferência.</p><p>O envio é retomado ao abrir o início ou quando a conexão voltar.</p><a className="seller-button seller-secondary" href="/scrap/schedule">Ver agendamentos e pendências</a></section>}
    <a className="seller-button seller-secondary" href="/login">Acessar outra conta</a>
  </ScrapShell>;
}
