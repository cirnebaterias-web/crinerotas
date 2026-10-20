import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

const client = {
  schemaVersion: 1,
  id: '31100000-0000-4000-8000-000000000001',
  externalReference: 'CLIENTE-E2E-311',
  name: 'Cliente Excel Sintético',
  address: 'Rua da Importação, 311',
  latitude: -5.79,
  longitude: -35.21,
  portfolioReference: 'CARTEIRA-E2E',
  sellerId: '31100000-0000-4000-8000-000000000003',
  sellerEmail: 'seller-e2e.synthetic@example.invalid',
  status: 'active',
  version: 1,
} as const;

function clientListPayload(clients: readonly (typeof client)[], url: URL) {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  const filtered = query
    ? clients.filter((item) => item.externalReference.includes(query) || item.name.includes(query))
    : [...clients];
  const totalPages = Math.ceil(filtered.length / pageSize);
  return {
    schemaVersion: 1 as const,
    query,
    clients: filtered.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page, pageSize, totalCount: filtered.length, totalPages,
      hasPrevious: page > 1, hasNext: page < totalPages,
    },
  };
}

test.describe('controlled client import management', () => {
  test.use({ serviceWorkers: 'block' });

  test('validates the workbook, imports accepted rows and refreshes the client list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let imported = false;
    let validateCalls = 0;
    let importCalls = 0;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31100000-0000-4000-8000-000000000004', displayName: 'Gestor E2E',
          roles: ['manager'], capabilities: ['clients.read', 'clients.import'], scopeIds: [], status: 'active',
        } });
        return;
      }
      if (pathname === '/api/v1/clients') {
        await route.fulfill({ json: clientListPayload(imported ? [client] : [], url) });
        return;
      }
      if (pathname === '/api/v1/client-imports/validate') {
        validateCalls += 1;
        await route.fulfill({ json: {
          schemaVersion: 1, sourceName: 'clientes-e2e.xlsx', sourceChecksum: 'a'.repeat(64),
          totalCount: 1, acceptedCount: 1, rejectedCount: 0,
          rows: [{ rowNumber: 2, externalReference: client.externalReference, name: client.name,
            address: client.address, latitude: client.latitude, longitude: client.longitude,
            portfolioReference: client.portfolioReference, sellerEmail: client.sellerEmail,
            status: client.status }], issues: [],
        } });
        return;
      }
      if (pathname === '/api/v1/client-imports' && request.method() === 'POST') {
        importCalls += 1;
        imported = true;
        await route.fulfill({ status: 201, json: {
          schemaVersion: 1, id: '31100000-0000-4000-8000-000000000002', sourceName: 'clientes-e2e.xlsx',
          sourceChecksum: 'a'.repeat(64), status: 'completed', totalCount: 1, acceptedCount: 1,
          rejectedCount: 0, importedAt: '2026-10-10T12:00:00.000Z',
          completedAt: '2026-10-10T12:00:01.000Z', replayed: false, issues: [],
        } });
        return;
      }
      await route.continue();
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clientes');
    sheet.addRow(['referencia_externa', 'nome', 'endereco', 'latitude', 'longitude',
      'referencia_carteira', 'vendedor_email', 'status']);
    sheet.addRow([client.externalReference, client.name, client.address, client.latitude, client.longitude,
      client.portfolioReference, client.sellerEmail, client.status]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await page.goto('/management/clients');
    await expect(page.getByRole('heading', { name: 'Base de clientes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Importar planilha oficial' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Baixar modelo Excel' })).toHaveAttribute(
      'href', '/api/v1/client-imports/template',
    );
    await page.getByLabel('Planilha Excel').setInputFiles({
      name: 'clientes-e2e.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });
    await expect(page.getByText(/Arquivo selecionado:/)).toContainText('clientes-e2e.xlsx');
    await page.getByRole('button', { name: 'Validar' }).click();
    await expect(page.getByText('Planilha válida e pronta para importar.')).toBeVisible();
    await expect(page.getByText(/Total: 1/)).toContainText('Aceitas: 1');
    expect(validateCalls).toBe(1);

    await page.getByRole('button', { name: 'Importar linhas válidas' }).click();
    await expect(page.getByText(/Base de clientes atualizada/)).toBeVisible();
    await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
    await expect(page.getByText(client.address)).toBeVisible();
    expect(importCalls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
