import type { MeResponse } from '@cirne/contracts';

export type ManagementNavigationItem = { href: string; label: string; capability: string };

const items: ManagementNavigationItem[] = [
  { href: '/management/day', label: 'Central do dia', capability: 'route.read_scoped' },
  { href: '/management/routes', label: 'Planejar rotas', capability: 'route.plan_scoped' },
  { href: '/management/route-proposals', label: 'Sugestão semanal', capability: 'route.plan_scoped' },
  { href: '/management/intelligence', label: 'Inteligência de campo', capability: 'route.read_scoped' },
  { href: '/management/pilot', label: 'Indicadores do piloto', capability: 'route.read_scoped' },
  { href: '/management/commercial-actions', label: 'Ações comerciais', capability: 'route.plan_scoped' },
  { href: '/management/clients', label: 'Clientes', capability: 'clients.read' },
  { href: '/management/scrap/ledger', label: 'Saldo de sucata', capability: 'scrap_ledger.sync' },
  { href: '/management/scrap', label: 'Operação de sucata', capability: 'scrap.read_operations' },
  { href: '/management/scrap/logistics', label: 'Rotas de coleta', capability: 'scrap.dispatch_pickups' },
  { href: '/management/scrap/agenda', label: 'Agenda de coletas', capability: 'scrap.read_operations' },
  { href: '/management/administration', label: 'Administração', capability: 'identity.manage' },
];

export function visibleManagementNavigationItems(identity: Pick<MeResponse, 'capabilities'> | null) {
  return items.filter((item) => (
    identity ? identity.capabilities.includes(item.capability) : item.href === '/management/day'
  ));
}
