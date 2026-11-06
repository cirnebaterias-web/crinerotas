import type { MeResponse } from '@cirne/contracts';

export function managerHomeOperations(identity: Pick<MeResponse, 'roles' | 'capabilities'>) {
  if (!identity.roles.includes('manager')) return [];
  return [
    ...(identity.capabilities.includes('route.read_scoped') ? [{
      href: '/management/day', title: 'Central do gestor',
      description: 'Acompanhe as rotas e atividades da data selecionada',
    }] : []),
    ...(identity.capabilities.includes('route.plan_scoped') ? [{
      href: '/management/routes', title: 'Criar rota do dia',
      description: 'Escolha o vendedor, organize os clientes e publique a rota',
    }] : []),
    ...(identity.capabilities.includes('route.read_scoped') ? [{
      href: '/management/pilot', title: 'Métricas do piloto',
      description: 'Resultados provisórios e fontes ainda pendentes',
    }] : []),
  ];
}
