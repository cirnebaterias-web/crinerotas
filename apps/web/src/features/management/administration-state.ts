import type { AdministrationRoleCode, AdministrationUser } from '@cirne/contracts';

export const administrationRoleLabels: Record<AdministrationRoleCode, string> = {
  seller: 'Vendedor', manager: 'Gestor', administrator: 'Administrador', logistics: 'Logística',
};
const administrationStatusLabels: Record<AdministrationUser['status'], string> = {
  active: 'Ativo', inactive: 'Bloqueado',
};

export function filterAdministrationUsers(users: AdministrationUser[], query: string) {
  const normalized = query.trim().toLocaleLowerCase('pt-BR');
  if (!normalized) return users;
  return users.filter((user) => `${user.displayName} ${user.roles.map((role) => administrationRoleLabels[role]).join(' ')} ${administrationStatusLabels[user.status]}`
    .toLocaleLowerCase('pt-BR').includes(normalized));
}

export function replaceAdministrationUser(users: AdministrationUser[], updated: AdministrationUser) {
  return users.map((user) => user.id === updated.id ? updated : user);
}
