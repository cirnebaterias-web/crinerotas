import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { test } from './real-route-fixture';

test('authorized manager reads a server-confirmed pending schedule without browser API mocks', async ({
  page,
  realRoute,
}) => {
  const client = realRoute.clients[0]!;
  const requestedAt = new Date().toISOString();
  const desiredDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const useRancherDesktopWsl = process.platform === 'win32' &&
    process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
  const dockerProgram = useRancherDesktopWsl ? 'wsl' : 'docker';
  const dockerPrefix = useRancherDesktopWsl ? ['-d', 'rancher-desktop', '--', 'docker'] : [];
  const scheduleId = crypto.randomUUID();
  const offlineId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  await promisify(execFile)(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c',
    `insert into api.client_seller_scopes (client_id, seller_id, assigned_by)
      values ('${client.id}', '${realRoute.seller.id}', '${realRoute.manager.id}');
    insert into api.pickup_schedules (
      id, offline_id, seller_id, device_id, client_id, client_name_snapshot, address_snapshot,
      seller_name_snapshot, estimated_weight_kg, desired_date, period, observation, requested_at, origin
    ) values (
      '${scheduleId}', '${offlineId}', '${realRoute.seller.id}', '${deviceId}', '${client.id}',
      '${client.name}', 'Endereco E2E sintetico da agenda', 'Vendedor agenda E2E sintetico',
      42.50, '${desiredDate}', 'morning', 'Agenda E2E sintetica confirmada pelo servidor',
      '${requestedAt}', 'standalone'
    )`], { windowsHide: true, timeout: 25_000 });

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(realRoute.manager.email);
  await page.getByLabel('Senha', { exact: true }).fill(realRoute.manager.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/management\/scrap$/);

  await page.goto(`/management/scrap/agenda?from=${desiredDate}&to=${desiredDate}&sellerId=${realRoute.seller.id}&clientId=${client.id}`);
  await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
  await expect(page.getByText('42.50 kg estimados', { exact: false })).toBeVisible();
  await expect(page.getByText('Estado: Pendente', { exact: false })).toBeVisible();
  await expect(page.getByText('Kg coletados')).toHaveCount(0);
  await expect(page.getByText('Acesso não autorizado.')).toHaveCount(0);
});
