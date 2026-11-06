import { expect, test, type Page, type Route } from '@playwright/test';
const result = { id: '31300000-0000-4000-8000-000000000001', sourceKey: 'a'.repeat(64),
  status: 'completed_with_pending', trigger: 'manual', startedAt: '2026-11-03T09:00:00Z',
  completedAt: '2026-11-03T09:00:01Z', acceptedCount: 1, pendingCount: 1, ignoredCount: 1,
  batchId: '31300000-0000-4000-8000-000000000002', errorCode: null,
  issues: [{ rowNumber: 4, code: 'STATUS_PENDING_REVIEW', message: 'Status pendente de revisão. Informe ATIVO ou INATIVO.' }] };
const status = { configured: true, reason: 'ready', scheduleEnabled: false,
  timeZone: 'America/Sao_Paulo', times: ['06:00', '13:00'], latest: null };
async function mockPage(page: Page, sync: (route: Route) => Promise<void>, canImport = true) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me') return route.fulfill({ json: {
      id: '31300000-0000-4000-8000-000000000004', displayName: 'Gestor Sintético', roles: ['manager'],
      capabilities: canImport ? ['clients.read', 'clients.import'] : ['clients.read'], scopeIds: [], status: 'active',
    } });
    if (path === '/api/v1/clients') return route.fulfill({ json: {
      schemaVersion: 1, query: '', clients: [], pagination: { page: 1, pageSize: 25, totalCount: 0,
        totalPages: 0, hasPrevious: false, hasNext: false },
    } });
    if (path === '/api/v1/client-sync') return sync(route);
    return route.continue();
  });
  await page.goto('/management/clients');
}
test.describe('Google Sheets manual update', () => {
  test.use({ serviceWorkers: 'block' });
  test('shows inactive state and two scheduled hours without claiming activation', async ({ page }) => {
    let writes = 0;
    await mockPage(page, async (route) => {
      if (route.request().method() === 'POST') writes++;
      await route.fulfill({ json: { ...status, configured: false, reason: 'disabled' } });
    });
    await expect(page.getByRole('button', { name: 'Atualizar agora', exact: true })).toBeDisabled();
    await expect(page.getByText('06:00 e 13:00 — horário de Brasília')).toBeVisible();
    await expect(page.getByText(/Integração inativa/)).toBeVisible();
    await expect(page.getByText('Agendamento ainda não ativado na VPS.')).toBeVisible();
    expect(writes).toBe(0);
  });
  test('waits for persisted confirmation, prevents duplicate clicks and displays pending rows on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let writes = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    await mockPage(page, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: status });
      writes++;
      await barrier;
      await route.fulfill({ json: result });
    });
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Atualizando…' })).toBeDisabled();
    await expect(page.getByText(/Atualização confirmada/)).toHaveCount(0);
    release();
    await expect(page.getByText(/Atualização confirmada/)).toBeVisible();
    await expect(page.getByText('Importados: 1 · Ignorados (OUTROS): 1 · Pendentes de revisão: 1')).toBeVisible();
    await expect(page.getByText(/Linha 4:/)).toBeVisible();
    expect(writes).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test('labels recovery honestly and reuses the lost-response key before allowing a fresh update', async ({ page }) => {
    const keys: string[] = [];
    await mockPage(page, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { ...status, latest: keys.length ? result : null } });
      const body = route.request().postDataJSON() as { trigger: string; idempotencyKey: string };
      expect(body.trigger).toBe('manual');
      keys.push(body.idempotencyKey);
      if (keys.length === 1) return route.abort('failed');
      await route.fulfill({ json: result });
    });
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expect(page.getByText(/Não foi possível confirmar a atualização/)).toBeVisible();
    await page.getByRole('button', { name: 'Consultar estado', exact: true }).click();
    await expect(page.getByText(/Concluída com pendências/)).toBeVisible();
    await page.getByRole('button', { name: 'Recuperar tentativa', exact: true }).click();
    await expect(page.getByText(/Atualização confirmada/)).toBeVisible();
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expect.poll(() => keys.length).toBe(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
  test('does not expose sync controls without the import capability', async ({ page }) => {
    let reads = 0;
    await mockPage(page, async (route) => { reads++; await route.fulfill({ json: status }); }, false);
    await expect(page.getByRole('heading', { name: 'Base de clientes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Atualização pelo Google Planilhas' })).toHaveCount(0);
    expect(reads).toBe(0);
  });
  test('preserves the latest state after a failed refresh and never presents failed execution as success', async ({ page }) => {
    let reads = 0;
    await mockPage(page, async (route) => {
      if (route.request().method() === 'POST') return route.fulfill({ json: { ...result,
        status: 'failed', errorCode: 'DEPENDENCY_UNAVAILABLE', acceptedCount: 0, pendingCount: 0, issues: [] } });
      reads++;
      return route.fulfill(reads === 1 ? { json: { ...status, latest: result } } : { status: 503, json: {} });
    });
    await page.getByRole('button', { name: 'Consultar estado', exact: true }).click();
    await expect(page.getByText(/A última informação permanece exibida/)).toBeVisible();
    await expect(page.getByText(/Concluída com pendências/)).toBeVisible();
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expect(page.getByText(/A atualização falhou/)).toBeVisible();
    await expect(page.getByText(/Atualização confirmada/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Atualizar agora', exact: true })).toBeEnabled();
  });
});
