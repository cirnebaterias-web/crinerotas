import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

test('manager downloads the empty official Base clientes worksheet', async ({ page, request }) => {
  const anonymous = await request.get('/api/v1/client-imports/template');
  expect(anonymous.status()).toBe(401);
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: { manager_a: { email: string; password: string } };
  };
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(manifest.actors.manager_a.email);
  await page.getByLabel('Senha', { exact: true }).fill(manifest.actors.manager_a.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/management\/day$/);
  await page.goto('/management/clients');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Baixar modelo Excel', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('modelo-clientes-cirne.xlsx');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(downloadPath!);
  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Base clientes']);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.actualRowCount).toBe(1);
  expect(sheet.columnCount).toBe(21);
  expect(sheet.getCell('A1').value).toBe('Razão Social');
  expect(sheet.getCell('U1').value).toBe('Google Place ID');
  await download.saveAs('.local/modelo-clientes-cirne.xlsx');
});
