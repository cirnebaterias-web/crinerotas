import { expect, test } from '@playwright/test';

const sellerId = '11111111-1111-4111-8111-111111111111';
const routeId = '20000000-0000-4000-8000-000000000001';
const routeVersionId = '30000000-0000-4000-8000-000000000001';
const clients = [
  { id: '40000000-0000-4000-8000-000000000001', externalReference: 'CLI-001', name: 'Loja Centro', address: 'Rua Central, 10', portfolioReference: 'CARTEIRA-A' },
  { id: '40000000-0000-4000-8000-000000000002', externalReference: 'CLI-002', name: 'Loja Norte', address: 'Rua Norte, 20', portfolioReference: 'CARTEIRA-A' },
];

test.describe('manager route planning', () => {
  test.use({ serviceWorkers: 'block' });

  test('builds, reviews, and publishes one scoped route without drag-only interaction', async ({ page }) => {
    let state: 'empty' | 'draft' | 'published' | 'successor' = 'empty';
    let currentVersion = 1;
    let changeReason: string | null = null;
    let conflictNextPatch = false;
    let persistedStops: Array<{ clientId: string; plannedOrder: number; priority: number }> = [];
    let postedBody: Record<string, unknown> | null = null;

    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: '50000000-0000-4000-8000-000000000001', displayName: 'Gestor Sintético', roles: ['manager'],
      capabilities: ['identity.read_self', 'route.read_scoped', 'route.plan_scoped', 'clients.read', 'clients.manage'],
      scopeIds: [sellerId], status: 'active',
    }) }));
    await page.route('**/api/v1/clients/sellers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      schemaVersion: 1, sellers: [{ id: sellerId, displayName: 'Vendedor Sintético', email: 'seller@example.invalid' }],
    }) }));
    await page.route('**/api/v1/clients?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      schemaVersion: 1, query: '', clients: clients.map((client) => ({
        schemaVersion: 1, ...client, latitude: null, longitude: null, sellerId,
        sellerEmail: 'seller@example.invalid', status: 'active', version: 1,
      })),
      pagination: { page: 1, pageSize: 25, totalCount: 2, totalPages: 1, hasPrevious: false, hasNext: false },
    }) }));
    await page.route('**/api/v1/routes?*', (route) => {
      const serviceDate = new URL(route.request().url()).searchParams.get('serviceDate');
      if (state === 'empty') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          schemaVersion: 1, availability: 'empty', serviceDate, sellerId,
        }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, availability: 'available', route: {
          routeId,
          routeVersionId: currentVersion === 1 ? routeVersionId : '30000000-0000-4000-8000-000000000002',
          versionNumber: currentVersion,
          expectedVersion: state === 'draft' ? 1 : state === 'successor' ? 3 : currentVersion === 1 ? 2 : 4,
          serviceDate,
          state: state === 'draft' ? 'initial_draft' : state === 'successor' ? 'successor_draft' : 'published',
          seller: { id: sellerId, displayName: 'Vendedor Sintético' },
          publishedVersionNumber: state === 'draft' ? null : state === 'successor' ? 1 : currentVersion,
          changeReason,
          stops: persistedStops.map((stop, index) => ({
            routeVersionStopId: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            plannedOrder: stop.plannedOrder, priority: stop.priority,
            client: { ...clients.find((client) => client.id === stop.clientId)!, latitude: null, longitude: null, active: true },
          })),
        },
      }) });
    });
    await page.route('**/api/v1/routes', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      postedBody = await route.request().postDataJSON();
      persistedStops = (postedBody as { stops: typeof persistedStops }).stops;
      state = 'draft';
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, routeId, routeVersionId, versionNumber: 1, expectedVersion: 1,
        serviceDate: (postedBody as { serviceDate: string }).serviceDate, sellerId, status: 'draft',
        stops: persistedStops.map((stop, index) => ({ ...stop,
          routeVersionStopId: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })),
      }) });
    });
    await page.route(`**/api/v1/routes/${routeId}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      if (conflictNextPatch) {
        conflictNextPatch = false;
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
          error: { code: 'VERSION_CONFLICT', message: 'A versão enviada conflita com o servidor.', recoverable: false },
        }) });
      }
      const body = await route.request().postDataJSON() as {
        reason: string;
        stops: typeof persistedStops;
      };
      const previousClientIds = new Set(persistedStops.map((stop) => stop.clientId));
      persistedStops = body.stops;
      changeReason = body.reason;
      currentVersion = 2;
      state = 'successor';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, routeId,
        routeVersionId: '30000000-0000-4000-8000-000000000002',
        versionNumber: 2, expectedVersion: 3, serviceDate: '2026-10-29', sellerId, status: 'draft',
        changed: true, changeReason,
        changeSummary: {
          addedClientIds: persistedStops.filter((stop) => !previousClientIds.has(stop.clientId)).map((stop) => stop.clientId),
          removedClientIds: [...previousClientIds].filter((id) => !persistedStops.some((stop) => stop.clientId === id)),
          retainedClientIds: persistedStops.filter((stop) => previousClientIds.has(stop.clientId)).map((stop) => stop.clientId),
        },
        stops: persistedStops.map((stop, index) => ({ ...stop,
          routeVersionStopId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })),
      }) });
    });
    await page.route(`**/api/v1/routes/${routeId}/publish`, (route) => {
      state = 'published';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, routeId,
        routeVersionId: currentVersion === 1 ? routeVersionId : '30000000-0000-4000-8000-000000000002',
        versionNumber: currentVersion, expectedVersion: currentVersion === 1 ? 2 : 4,
        status: 'published', publishedBy: '50000000-0000-4000-8000-000000000001',
        publishedAt: '2026-10-29T12:00:00.000Z', stopCount: persistedStops.length,
      }) });
    });

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/management/routes');
    await expect(page.getByRole('heading', { name: 'Planejar rotas' })).toBeVisible();
    await expect(page.getByText('Sem rota', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Clientes disponíveis' })).toBeVisible();

    await page.getByRole('button', { name: 'Adicionar' }).first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Adicionar' }).click();
    await page.getByLabel('Mover Loja Centro para baixo').click();
    await expect(page.locator('.route-planner-stop-list li').first()).toContainText('Loja Norte');
    await page.getByLabel('Prioridade de Loja Norte').selectOption('3');
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await expect(page.getByText('Rascunho criado e preservado no servidor.')).toBeVisible();
    expect(persistedStops).toEqual([
      { clientId: clients[1]!.id, plannedOrder: 1, priority: 3 },
      { clientId: clients[0]!.id, plannedOrder: 2, priority: 0 },
    ]);

    await page.getByLabel('Prioridade de Loja Norte').selectOption('4');
    await expect(page.getByRole('button', { name: 'Revisar e publicar' })).toBeDisabled();
    await expect(page.getByText('Salve a composição atual antes de revisar a publicação.')).toBeVisible();
    await page.getByLabel('Prioridade de Loja Norte').selectOption('3');
    await expect(page.getByRole('button', { name: 'Revisar e publicar' })).toBeEnabled();

    await page.getByRole('button', { name: 'Revisar e publicar' }).click();
    const publicationDialog = page.getByRole('dialog', { name: 'Publicar esta rota?' });
    await expect(publicationDialog).toContainText('2 paradas');
    await expect(page.getByRole('button', { name: 'Voltar e revisar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(publicationDialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revisar e publicar' })).toBeFocused();
    await page.getByRole('button', { name: 'Revisar e publicar' }).click();
    await page.getByRole('button', { name: 'Confirmar publicação' }).click();
    await expect(page.getByText('Rota publicada e disponibilizada para o vendedor.')).toBeVisible();
    await expect(page.getByText('Rota publicada', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir Central do dia' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);

    await page.getByLabel('Prioridade de Loja Norte').selectOption('4');
    await page.getByLabel('Motivo da alteração').fill('Ajuste comercial confirmado pelo gestor');
    await page.getByRole('button', { name: 'Criar revisão' }).click();
    await expect(page.getByText('Rascunho atualizado e preservado no servidor.')).toBeVisible();
    await expect(page.getByText('Revisão em rascunho', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Revisar e publicar' }).click();
    await page.getByRole('button', { name: 'Confirmar publicação' }).click();
    await expect(page.getByText('Rota publicada e disponibilizada para o vendedor.')).toBeVisible();
    await expect(page.getByText('Versão 2 · controle 4')).toBeVisible();

    await page.getByLabel('Prioridade de Loja Norte').selectOption('5');
    await page.getByLabel('Motivo da alteração').fill('Edição local preservada no conflito');
    conflictNextPatch = true;
    await page.getByRole('button', { name: 'Criar revisão' }).click();
    await expect(page.locator('.route-planner-message[role="alert"]'))
      .toContainText('Sua composição continua nesta tela');
    await expect(page.getByLabel('Prioridade de Loja Norte')).toHaveValue('5');

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Atalhos do planejamento' })).toBeVisible();

    const menuButton = page.getByRole('button', { name: 'Menu' });
    await menuButton.click();
    await expect(page.getByRole('region', { name: 'Menu da gestão' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fechar ×' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(menuButton).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Menu da gestão' })).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    await page.getByLabel('Data da rota').fill('');
    const discardDialog = page.getByRole('dialog', { name: 'Trocar o planejamento?' });
    await expect(discardDialog).toContainText('descartar essas alterações locais');
    await page.keyboard.press('Escape');
    await expect(discardDialog).toHaveCount(0);
    await expect(page.getByLabel('Prioridade de Loja Norte')).toHaveValue('5');
    await expect(page.getByLabel('Data da rota')).not.toHaveValue('');

    await page.getByLabel('Data da rota').fill('');
    await page.getByRole('button', { name: 'Descartar alterações' }).click();
    await expect(page.getByText('Informe uma data válida para consultar o planejamento.')).toBeVisible();
    await expect(page.getByText('—', { exact: true })).toBeVisible();
    await expect(page.getByText('Abrir Central do dia')).toHaveAttribute('aria-disabled', 'true');
  });

  test('shows a recoverable state and sanitized retry for a planning dependency failure', async ({ page }) => {
    let planningAttempts = 0;
    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: '50000000-0000-4000-8000-000000000001', displayName: 'Gestor Sintético', roles: ['manager'],
      capabilities: ['identity.read_self', 'route.read_scoped', 'route.plan_scoped', 'clients.read'],
      scopeIds: [sellerId], status: 'active',
    }) }));
    await page.route('**/api/v1/clients/sellers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      schemaVersion: 1, sellers: [{ id: sellerId, displayName: 'Vendedor Sintético', email: 'seller@example.invalid' }],
    }) }));
    await page.route('**/api/v1/clients?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      schemaVersion: 1, query: '', clients: [],
      pagination: { page: 1, pageSize: 25, totalCount: 0, totalPages: 0, hasPrevious: false, hasNext: false },
    }) }));
    await page.route('**/api/v1/routes?*', (route) => {
      planningAttempts += 1;
      if (planningAttempts === 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          error: { code: 'DEPENDENCY_UNAVAILABLE', message: '[{ "technical": "zod internals" }]', recoverable: true },
        }) });
      }
      const serviceDate = new URL(route.request().url()).searchParams.get('serviceDate');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        schemaVersion: 1, availability: 'empty', serviceDate, sellerId,
      }) });
    });

    await page.goto('/management/routes');
    await expect(page.getByText('Falha ao consultar', { exact: true })).toBeVisible();
    await expect(page.getByText('Não foi possível carregar o planejamento. Sua última composição continua nesta tela; tente novamente.')).toBeVisible();
    await expect(page.getByText('zod internals')).toHaveCount(0);
    await page.getByRole('button', { name: 'Tentar carregar novamente' }).click();
    await expect(page.getByText('Sem rota', { exact: true })).toBeVisible();
    await expect(page.getByText('Planejamento atualizado.')).toBeVisible();
  });
});
