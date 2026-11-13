'use client';

import { useEffect, useRef, useState } from 'react';
import type { MeResponse } from '@cirne/contracts';
import { sellerClient } from '@/lib/seller-client';
import { ScrapShell } from '@/features/scrap/scrap-ui';
import { StandaloneScrapScheduleStore } from '@/lib/offline/standalone-scrap';
import type { LocalStandaloneScrapSchedule } from '@/lib/offline/database';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { OfflineFoundationService } from '@/lib/offline/service';
import { managerHomeOperations } from './manager-home-operations';
import { Button } from '@/components/ui';
import { StatusBanner } from '@/components/feedback';

export function SellerHomeScreen() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [error, setError] = useState('');
  const [schedules, setSchedules] = useState<LocalStandaloneScrapSchedule[]>([]);
  const [loggingOut, setLoggingOut] = useState(false);
  const accessBlocked = useRef(false);
  const logoutInFlight = useRef(false);
  const scheduleStore = useRef<StandaloneScrapScheduleStore | null>(null);
  useEffect(() => {
    let active = true;
    const stop = observeLocalAccessRevocation(() => {
      active = false;
      if (!accessBlocked.current) setError('Entre novamente para acessar sua operação.');
      accessBlocked.current = true; scheduleStore.current?.close(); setIdentity(null);
    });
    void sellerClient.identity().then((user) => { if (active && !accessBlocked.current) setIdentity(user); }).catch(() => { if (active && !accessBlocked.current) setError('Entre novamente para acessar sua operação.'); });
    return () => { active = false; stop(); };
  }, []);
  useEffect(() => {
    const store = new StandaloneScrapScheduleStore(); let active = true;
    scheduleStore.current = store;
    async function resume() {
      if (!active || accessBlocked.current) return;
      try {
        const saved = await store.listSchedules();
        if (!active || accessBlocked.current) return;
        setSchedules(saved);
        const synchronized = await store.synchronize();
        if (active && !accessBlocked.current) setSchedules(synchronized);
      }
      catch { /* Authenticated operational entry still displays its own access state. */ }
    }
    const online = () => { void resume(); };
    const stop = observeLocalAccessRevocation(() => {
      active = false; setSchedules([]); setIdentity(null);
      if (!accessBlocked.current) setError('Entre novamente para acessar sua operação.');
      accessBlocked.current = true; store.close();
    });
    void resume(); window.addEventListener('online', online);
    return () => {
      active = false; stop(); window.removeEventListener('online', online); store.close();
      if (scheduleStore.current === store) scheduleStore.current = null;
    };
  }, []);

  async function logout() {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    accessBlocked.current = true;
    scheduleStore.current?.close();
    const userId = identity?.id;
    setIdentity(null); setSchedules([]); setError(''); setLoggingOut(true);
    const localService = new OfflineFoundationService();
    try {
      try { await localService.revokeLocalAccess(userId); }
      catch { /* Keep the private UI hidden and attempt the remote logout even when local storage fails. */ }
      await sellerClient.logout();
      window.location.replace('/login');
    } catch {
      setError('Os dados foram ocultados. Reconecte-se e tente sair novamente para confirmar o encerramento da sessão.');
      setLoggingOut(false);
    } finally {
      localService.close();
      logoutInFlight.current = false;
    }
  }

  return <ScrapShell><p className="seller-kicker">CIRNE ROTAS</p><h1>Seu dia de trabalho.</h1>{identity && <p className="seller-muted">{identity.displayName}</p>}
    {error && <StatusBanner tone="error" title="Acesso indisponível" className="seller-notice">{error} <a href="/login">Entrar</a></StatusBanner>}
    {!identity && !error && <p role="status">{loggingOut ? 'Encerrando sua sessão…' : 'Validando seu acesso…'}</p>}
    {identity && <section className="seller-task-list" aria-label="Operações disponíveis">
      {identity.capabilities.includes('route.read_self') && <a className="seller-task-card" href="/route"><span><strong>Rota</strong><small>Paradas e tarefas das visitas</small></span><span aria-hidden="true">→</span></a>}
      {managerHomeOperations(identity).map((operation) => <a key={operation.href} className="seller-task-card" href={operation.href}><span><strong>{operation.title}</strong><small>{operation.description}</small></span><span aria-hidden="true">→</span></a>)}
      {identity.capabilities.includes('scrap.schedule_self') && <a className="seller-task-card" href="/scrap/schedule"><span><strong>Agendar coleta de sucata</strong><small>Agende por contato com o cliente, mesmo fora da rota</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('scrap.collect_self') && <a className="seller-task-card" href="/route"><span><strong>Registrar coleta de sucata</strong><small>Na rota, abra o cliente e a tarefa Sucata da visita. Termo e foto obrigatórios.</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('scrap.execute_pickups') && <a className="seller-task-card" href="/logistics"><span><strong>Minha rota de coletas</strong><small>Consulte as coletas atribuídas e registre o peso realmente coletado</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('scrap.read_operations') && <a className="seller-task-card" href="/management/scrap"><span><strong>Sucata · Gestão e logística</strong><small>Agenda, custódia e recebimento</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('clients.import') && <a className="seller-task-card" href="/management/clients"><span><strong>Base de clientes</strong><small>Validar e importar planilha Excel</small></span><span aria-hidden="true">→</span></a>}
      {identity.capabilities.includes('identity.manage') && <a className="seller-task-card" href="/management/administration"><span><strong>Administração</strong><small>Usuários, acessos e parâmetros publicados</small></span><span aria-hidden="true">→</span></a>}
      <a className="seller-task-card" href="https://minhabateriaheliar.vercel.app/" target="_blank" rel="noopener noreferrer"><span><strong>Catálogo de baterias</strong><small>Consulte modelos e especificações de baterias</small></span><span aria-hidden="true">→</span></a>
      <a className="seller-task-card" href="https://apporbis.lovable.app/auth" target="_blank" rel="noopener noreferrer"><span><strong>Orbis</strong><small>Acesse a plataforma Orbis</small></span><span aria-hidden="true">→</span></a>
    </section>}
    {schedules.some((record) => record.status !== 'synced') && <section className="seller-progress" aria-label="Agendamentos de sucata pendentes"><h2>Agendamentos salvos no aparelho</h2><p role="status">{schedules.filter((record) => record.status === 'pending').length} aguardando envio · {schedules.filter((record) => record.status === 'action_required').length} requerem conferência.</p><p>O envio é retomado ao abrir o início ou quando a conexão voltar.</p><a className="seller-button seller-secondary" href="/scrap/schedule">Ver agendamentos e pendências</a></section>}
    <Button variant="secondary" className="seller-button seller-secondary" disabled={loggingOut} loading={loggingOut} loadingLabel="Saindo" onClick={() => void logout()}>{loggingOut ? 'Saindo…' : 'Sair'}</Button>
  </ScrapShell>;
}
