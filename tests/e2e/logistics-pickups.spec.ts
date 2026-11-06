import { expect, test, type Page } from '@playwright/test';
import type { LogisticsPickupRecord } from '@cirne/contracts';

const operator = { id: '61000000-0000-4000-8000-000000000001', displayName: 'Operador de teste' };
const manager = { id: '61000000-0000-4000-8000-000000000002', displayName: 'Gestor de teste' };
const at = '2026-11-04T12:00:00.000Z';
const record: LogisticsPickupRecord = {
  scheduleId: '61000000-0000-4000-8000-000000000003', version: 1,
  client: { id: '61000000-0000-4000-8000-000000000004', name: 'Cliente coleta de teste', document: '12345678000199', address: 'Rua de teste, 100 · Natal/RN' },
  seller: { id: '61000000-0000-4000-8000-000000000005', displayName: 'Vendedor teste' },
  promisedWeightKg: '100', desiredDate: '2026-11-04', period: 'morning', observation: 'Cenário sintético',
  assignment: { operator, routeDate: '2026-11-04', routeOrder: 1, assignedAt: at },
  result: null, resultOriginal: null, review: null, reviewRequired: false, history: [],
};

async function setup(page: Page, isManager = false, planning = false) {
  await page.addInitScript(({ initial, logistics, management, managerMode, planningMode, time }) => {
    const originalFetch = window.fetch.bind(window);
    let saved = initial;
    const actor = managerMode ? management : logistics;
    const identity = { ...actor, roles: [managerMode ? 'manager' : 'logistics'], status: 'active', scopeIds: [],
      capabilities: ['identity.read_self', 'scrap.read_operations', managerMode ? 'scrap.dispatch_pickups' : 'scrap.execute_pickups'] };
    if (managerMode && !planningMode) {
      const result = { outcome: 'collected' as const, actualWeightKg: '80', differenceKg: '-20', reason: 'Volume menor', recordedBy: logistics, recordedAt: time };
      saved = { ...saved, result, resultOriginal: result, reviewRequired: true };
    }
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/v1/me') return json(identity, sessionStorage.getItem('expired-session') === 'true' ? 401 : 200);
      if (url.pathname === '/api/v1/auth/session' && init?.method === 'POST') return json(identity);
      if (url.pathname === '/api/v1/scrap/collections') return json({ collections: [], totals: { collectedKg: '0', receivedKg: '0', scheduledKg: '100' } }, sessionStorage.getItem('fail-legacy-refresh') === 'true' ? 503 : 200);
      if (url.pathname === '/api/v1/logistics/operators') return json({ schemaVersion: 1, operators: [logistics] });
      if (url.pathname === '/api/v1/logistics/routes') {
        const routeStatus = planningMode ? 'draft' : saved.result ? 'in_progress' : 'assigned';
        return json({ schemaVersion: 1, date: url.searchParams.get('date'), generatedAt: time, routes: [{
          schemaVersion: 1, routeId: '61000000-0000-4000-8000-000000000006', version: saved.result ? 3 : 2,
          routeDate: url.searchParams.get('date'), status: routeStatus, operatorId: planningMode ? null : logistics.id, generatedAt: time,
          policy: { version: 'scrap-route-proximity-v1', method: 'centroid-edge-nearest-neighbor', distance: 'haversine_approximation' },
          stops: [{ scheduleId: initial.scheduleId, clientName: initial.client.name, address: initial.client.address,
            promisedWeightKg: initial.promisedWeightKg, location: null, suggestedOrder: 1,
            approximateFromPreviousKm: null, geographyStatus: 'pending_location', result: saved.result?.outcome ?? null }],
          counts: { total: 1, geocoded: 0, pendingLocation: 1, completed: saved.result ? 1 : 0 },
        }] });
      }
      if (url.pathname === '/api/v1/logistics/pickups') {
        const candidate = { ...initial, scheduleId: '61000000-0000-4000-8000-000000000007', version: 1,
          client: { ...initial.client, id: '61000000-0000-4000-8000-000000000008', name: 'Cliente adicional', address: 'Rua estreita, 20 · Parnamirim/RN' },
          promisedWeightKg: '75', assignment: null, observation: null };
        return json({ schemaVersion: 1, date: url.searchParams.get('date'), generatedAt: time,
          records: planningMode ? [saved, candidate] : [saved], totals: { promisedWeightKg: planningMode ? '175' : '100', collectedWeightKg: saved.result?.actualWeightKg ?? '0', differenceKg: saved.result?.differenceKg ?? '0', pending: saved.result ? 0 : planningMode ? 2 : 1, reviewRequired: saved.reviewRequired ? 1 : 0 } });
      }
      if (url.pathname.startsWith(`/api/v1/logistics/pickups/${initial.scheduleId}/`) && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const key = new Headers(init.headers).get('idempotency-key');
        const attempts = JSON.parse(sessionStorage.getItem('logistics-attempts') ?? '[]');
        attempts.push({ body, key }); sessionStorage.setItem('logistics-attempts', JSON.stringify(attempts));
        if (!managerMode && attempts.length === 1) throw new TypeError('Synthetic response lost');
        if (url.pathname.endsWith('/review')) saved = { ...saved, version: saved.version + 1, reviewRequired: false,
          review: { reason: body.reason, reviewedBy: management, reviewedAt: time } };
        else {
          const result = { outcome: body.outcome, actualWeightKg: body.actualWeightKg, differenceKg: String(Number(body.actualWeightKg) - 100), reason: body.reason ?? null, recordedBy: actor, recordedAt: time };
          saved = { ...saved, version: saved.version + 1, result, resultOriginal: saved.resultOriginal ?? result, review: null, reviewRequired: true };
        }
        return json(saved);
      }
      return originalFetch(input, init);
    };
  }, { initial: record, logistics: operator, management: manager, managerMode: isManager, planningMode: planning, time: at });
}

test.describe('logistics pickup reconciliation', () => {
  test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  test('logistics login opens the personal daily collection route', async ({ page }) => {
    await setup(page);
    await page.goto('/login');
    await page.getByLabel('E-mail', { exact: true }).fill('logistics@example.invalid');
    await page.getByLabel('Senha', { exact: true }).fill('synthetic-test-password');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/logistics$/);
    await expect(page.getByRole('heading', { name: 'Minha rota de coletas', exact: true })).toBeVisible();
    await expect(page.getByText('ROTA 61000000-0000-4000-8000-000000000006')).toBeVisible();
    await expect(page.getByRole('heading', { name: '0 de 1 coletas concluídas' })).toBeVisible();
    await expect(page.locator('.logistics-pickup-card')).toContainText(record.client.name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('operator preserves the promise, explains a partial collection and retries with the same key', async ({ page }) => {
    await setup(page);
    await page.goto('/logistics');
    const card = page.locator('.logistics-pickup-card');
    await expect(card).toContainText('CNPJ: 12.345.678/0001-99');
    await expect(card).toContainText(record.client.address);
    await page.getByRole('button', { name: 'Informar coleta' }).click();
    await expect(page.getByLabel('Peso realmente coletado em kg')).toHaveValue('');
    await page.getByLabel('Peso realmente coletado em kg').fill('80');
    await expect(page.getByLabel('Dia das coletas')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Atualizar coletas' })).toBeDisabled();
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('logistics-attempts'))).toBeNull();
    await page.getByLabel('Motivo / observação').fill('Cliente entregou somente 80 kg na conferência.');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    await expect(card.getByRole('alert')).toContainText('conexão não respondeu');
    await expect(page.getByLabel('Peso realmente coletado em kg')).toHaveValue('80');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    await expect(card).toContainText('Coleta parcial');
    await expect(card.getByRole('heading', { level: 3 })).toBeFocused();
    await card.getByText('Mais informações').click();
    await expect(card).toContainText('Revisão do gestor pendente');
    await expect(card).toContainText('100 kg agendados');
    await expect(card).toContainText('diferença -20 kg');
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('logistics-attempts') ?? '[]'));
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('manager records treatment without changing the promised or collected weights', async ({ page }) => {
    await setup(page, true);
    await page.goto('/management/scrap/logistics');
    const card = page.locator('.logistics-pickup-card');
    await page.getByRole('button', { name: 'Tratar divergência' }).click();
    await page.getByLabel('Tratamento e encaminhamento').fill('Cliente confirmou a diferença; vendedor orientado a conferir antes do agendamento.');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    await expect(card).toContainText('Tratamento registrado');
    await expect(card.locator('.logistics-weights')).toContainText('100 kg');
    await expect(card.locator('.logistics-weights')).toContainText('80 kg');
    await expect(card.locator('.logistics-weights')).toContainText('-20 kg');
    await expect(page.getByRole('button', { name: 'Corrigir resultado' })).toBeVisible();
  });

  test('manager composes a route without horizontal overflow and can undo local changes', async ({ page }) => {
    await setup(page, true, true);
    await page.goto('/management/scrap/logistics');
    const route = page.locator('.logistics-route-card');
    await route.getByLabel('Adicionar parada').selectOption({ label: 'Cliente adicional · 75 kg' });
    await expect(route.getByText('Alterações ainda não salvas.')).toBeVisible();
    await expect(route.getByRole('button', { name: 'Salvar paradas' })).toBeVisible();
    await expect(route.getByRole('button', { name: 'Retirar Cliente adicional' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await route.getByRole('button', { name: 'Desfazer alterações' }).click();
    await expect(route.locator('.logistics-route-stops').getByText('Cliente adicional')).toHaveCount(0);
    await expect(route.getByText('Alterações ainda não salvas.')).toHaveCount(0);
  });

  test('manager correction requires a reason and reopens review without changing the promise', async ({ page }) => {
    await setup(page, true);
    await page.goto('/management/scrap/logistics');
    const card = page.locator('.logistics-pickup-card');
    await page.getByRole('button', { name: 'Tratar divergência' }).click();
    await page.getByLabel('Tratamento e encaminhamento').fill('Conferência inicial de teste.');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    await expect(card).toContainText('Tratamento registrado');
    await page.getByRole('button', { name: 'Corrigir resultado' }).click();
    await expect(page.getByLabel('Peso realmente coletado em kg')).toHaveValue('80');
    await page.getByLabel('Peso realmente coletado em kg').fill('85');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('logistics-attempts') ?? '[]').length)).toBe(1);
    await page.getByLabel('Motivo / observação').fill('Correção sintética após nova conferência: 85 kg.');
    await page.getByRole('button', { name: 'Confirmar registro' }).click();
    await expect(card).toContainText('Revisão do gestor pendente');
    await expect(card.locator('.logistics-weights')).toContainText('100 kg');
    await expect(card.locator('.logistics-weights')).toContainText('85 kg');
    await expect(card.locator('.logistics-weights')).toContainText('-15 kg');
    await expect(page.getByRole('button', { name: 'Tratar divergência' })).toBeVisible();
  });

  test('recoverable legacy refresh preserves an embedded logistics draft but an expired session clears it', async ({ page }) => {
    await setup(page, true);
    await page.goto('/management/scrap');
    await page.getByRole('button', { name: 'Tratar divergência' }).click();
    const reason = page.getByLabel('Tratamento e encaminhamento');
    await reason.fill('Encaminhamento ainda em edição.');
    await page.evaluate(() => sessionStorage.setItem('fail-legacy-refresh', 'true'));
    await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'formulários foram preservados' })).toBeVisible();
    await expect(reason).toHaveValue('Encaminhamento ainda em edição.');
    await expect(page.getByRole('button', { name: 'Confirmar registro' })).toBeEnabled();
    await page.evaluate(() => sessionStorage.setItem('expired-session', 'true'));
    await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Seu acesso não foi autorizado' })).toBeVisible();
    await expect(reason).toHaveCount(0);
    await expect(page.locator('.logistics-pickup-card')).toHaveCount(0);
  });
});
