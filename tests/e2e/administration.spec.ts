import { expect, test } from '@playwright/test';

const administratorId = '10000000-0000-4000-8000-000000000001';
const managerId = '10000000-0000-4000-8000-000000000002';
const sellerId = '10000000-0000-4000-8000-000000000003';
const updatedAt = '2026-10-30T03:00:00.000Z';
const identity = { id: administratorId, displayName: 'Administrador Piloto', status: 'active',
  roles: ['administrator'], capabilities: ['identity.manage', 'identity.read_self'], scopeIds: [] };
const users = [
  { id: administratorId, displayName: 'Administrador Piloto', status: 'active', blockedAt: null,
    updatedAt, roles: ['administrator'], sellerScopeIds: [], lastAdministrativeChange: null },
  { id: managerId, displayName: 'Gestora Regional', status: 'active', blockedAt: null,
    updatedAt, roles: ['manager'], sellerScopeIds: [sellerId], lastAdministrativeChange: null },
  { id: sellerId, displayName: 'Vendedor Centro', status: 'active', blockedAt: null,
    updatedAt, roles: ['seller'], sellerScopeIds: [], lastAdministrativeChange: null },
];
const snapshot = { schemaVersion: 1, generatedAt: updatedAt, users,
  roles: [{ code: 'seller', name: 'Vendedor' }, { code: 'manager', name: 'Gestor' },
    { code: 'administrator', name: 'Administrador' }, { code: 'logistics', name: 'Logística' }],
  parameters: { mutationAvailability: 'blocked_pending_business_approval',
    blockers: ['AB-02', 'AB-03', 'AB-09'], current: { parameterSetId: '20000000-0000-4000-8000-000000000001',
      version: 3, validFrom: updatedAt, values: [{ id: '30000000-0000-4000-8000-000000000001',
        category: 'competitor', code: 'marca_x', label: 'Marca X', sortOrder: 1 }] } } };

async function mockIdentity(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify(identity) }));
}

test.describe('administration workspace', () => {
  test.use({ serviceWorkers: 'block' });

  test('searches, updates access and shows read-only parameter governance', async ({ page }) => {
    await mockIdentity(page);
    await page.route('**/api/v1/administration', (route) => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify(snapshot) }));
    let command: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/administration/users/${managerId}`, async (route) => {
      command = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      const updated = { ...users[1], status: 'inactive', blockedAt: '2026-10-30T03:10:00.000Z',
        updatedAt: '2026-10-30T03:10:00.000Z', lastAdministrativeChange: {
          action: 'identity.access.updated.v1', reason: command.reason,
          occurredAt: '2026-10-30T03:10:00.000Z' } };
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ schemaVersion: 1, replayed: false, user: updated }) });
    });
    await page.goto('/management/administration');
    await expect(page.getByRole('heading', { name: 'Administração', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Administração/ })).toBeVisible();
    await page.getByLabel('Buscar usuário').fill('gestora');
    await expect(page.getByRole('button', { name: /Gestora Regional/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Vendedor Centro/ })).toBeHidden();
    await page.getByRole('button', { name: /Gestora Regional/ }).click();
    await page.getByLabel('Bloqueado').check();
    await page.getByLabel('Motivo da alteração').fill('Bloqueio aprovado para validação do piloto');
    await page.getByRole('button', { name: 'Salvar acesso' }).click();
    await expect(page.getByRole('status')).toContainText('Acesso atualizado e auditado.');
    const capturedCommand = command as unknown as Record<string, unknown>;
    expect(capturedCommand).toMatchObject({ schemaVersion: 1, status: 'inactive', roles: ['manager'],
      sellerScopeIds: [sellerId], reason: 'Bloqueio aprovado para validação do piloto' });
    expect(capturedCommand.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Parâmetros publicados' })).toBeVisible();
    await expect(page.getByText('AB-02 · AB-03 · AB-09')).toBeVisible();
    await expect(page.getByText('Marca X')).toBeVisible();
    await expect(page.getByRole('button', { name: /publicar|parâmetro/i })).toHaveCount(0);
  });

  test('reloads a version conflict and preserves a clear failure state', async ({ page }) => {
    await mockIdentity(page);
    let reads = 0;
    await page.route('**/api/v1/administration', (route) => {
      reads += 1;
      const refreshed = { ...snapshot, users: users.map((user) => user.id === managerId
        ? { ...user, updatedAt: '2026-10-30T03:20:00.000Z' } : user) };
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(reads === 1 ? snapshot : refreshed) });
    });
    await page.route(`**/api/v1/administration/users/${managerId}`, (route) => route.fulfill({ status: 409,
      contentType: 'application/json', body: JSON.stringify({ error: { code: 'VERSION_CONFLICT',
        message: 'O registro mudou.', recoverable: false, timestamp: updatedAt,
        requestId: '40000000-0000-4000-8000-000000000001' } }) }));
    await page.goto('/management/administration');
    await page.getByLabel('Motivo da alteração').fill('Ajuste concorrente para validação do piloto');
    await page.getByRole('button', { name: 'Salvar acesso' }).click();
    await expect(page.getByRole('status')).toContainText('dados foram recarregados');
    expect(reads).toBe(2);
    await expect(page.getByText('Atualizado em')).toBeVisible();
  });

  test('keeps the compact layout within 390 pixels', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockIdentity(page);
    await page.route('**/api/v1/administration', (route) => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify(snapshot) }));
    await page.goto('/management/administration');
    await expect(page.getByRole('heading', { name: 'Administração', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
