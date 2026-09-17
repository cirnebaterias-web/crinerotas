import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('synthetic seller signs in and reorders the published route against local Supabase', async ({ page }) => {
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: { seller_a: { email: string; password: string } };
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.screenshot({ path: 'Docs/qa/evidence/2.3/login-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'Docs/qa/evidence/2.3/login-mobile.png', fullPage: true });
  await page.getByLabel('E-mail', { exact: true }).fill(manifest.actors.seller_a.email);
  await page.getByLabel('Senha', { exact: true }).fill(manifest.actors.seller_a.password);
  await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
  await expect(page).toHaveURL(/\/route$/);
  await expect(page.locator('.seller-stop-card')).toHaveCount(2);
  await page.screenshot({ path: 'Docs/qa/evidence/2.3/route-real-mobile.png', fullPage: true });
  const first = await page.locator('.seller-stop-card h3').first().innerText();
  await page.getByRole('button', { name: 'Reordenar' }).click();
  await page.getByRole('button', { name: `Descer ${first}`, exact: true }).click();
  await page.getByRole('button', { name: 'Salvar ordem' }).click();
  await expect(page.getByRole('status')).toContainText('Ordem salva e confirmada');
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await page.reload();
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'Docs/qa/evidence/2.3/route-real-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/route');
  await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
});
