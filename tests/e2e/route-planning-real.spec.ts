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
  await page.goto('/management/routes');

  await expect(page.getByRole('heading', { name: 'Planejar rotas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clientes disponíveis' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Composição da rota' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salvar e publicar' })).toBeVisible();
  await expect(page.getByLabel('Vendedor')).not.toHaveValue('');
  await expect(page.getByText('Rota publicada', { exact: true })).toBeVisible();
  await expect(page.getByText('Cliente Sintético 01', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Abrir Central do dia' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/route-planning-desktop.png', fullPage: true });
});
