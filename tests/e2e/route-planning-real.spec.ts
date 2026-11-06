import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('manager opens the real local desktop route planner', async ({ page }) => {
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: { manager_a?: { email: string; password: string } };
  };
  const manager = manifest.actors.manager_a;
  if (!manager) throw new Error('Provision the local manager actor before this real test.');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(manager.email);
  await page.getByLabel('Senha', { exact: true }).fill(manager.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/management\/day$/);
  const selectedDate = '2199-12-31';
  await page.getByLabel('Data operacional').fill(selectedDate);
  const planningLink = page.getByRole('link', { name: 'Criar ou editar rota do dia' });
  await expect(planningLink).toHaveAttribute('href', `/management/routes?serviceDate=${selectedDate}`);
  await page.screenshot({ path: '.local/management-day-route-action.png', fullPage: true });
  await planningLink.click();

  await expect(page.getByRole('heading', { name: 'Planejar rotas' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/management/routes\\?serviceDate=${selectedDate}$`));
  await expect(page.getByLabel('Data da rota')).toHaveValue(selectedDate);
  await expect(page.getByRole('heading', { name: 'Clientes disponíveis' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Composição da rota' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salvar e publicar' })).toBeVisible();
  await expect(page.getByLabel('Vendedor')).not.toHaveValue('');
  await expect(page.getByText('Sem rota', { exact: true })).toBeVisible();
  await expect(page.getByText('Cliente Sintético 01', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar' }).first().click();
  await expect(page.getByRole('button', { name: 'Salvar rascunho' })).toBeEnabled();
  await expect(page.locator('.route-planner-composition .route-planner-section-title')).toContainText('1/50');
  await expect(page.getByRole('link', { name: 'Abrir Central do dia' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/route-planning-desktop.png', fullPage: true });

  await page.goto('/home');
  await expect(page.getByRole('link', { name: /Central do gestor/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Criar rota do dia/ })).toBeVisible();

  await page.goto('/management/scrap');
  const commercialActionsLink = page.getByRole('link', { name: 'Ações comerciais', exact: true });
  await expect(commercialActionsLink).toHaveCount(1);
  await expect(page.locator('aside.management-sidebar').getByRole('link', { name: 'Ações comerciais', exact: true })).toBeVisible();
  await expect(page.locator('main').getByRole('link', { name: 'Ações comerciais', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/management-scrap-navigation.png', fullPage: true });
});
