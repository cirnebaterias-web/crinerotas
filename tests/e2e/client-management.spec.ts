import { expect, test } from '@playwright/test';
import type { ClientDetail } from '@cirne/contracts';

const seller = {
  id: '31200000-0000-4000-8000-000000000001',
  displayName: 'Vendedor Sintético',
  email: 'seller-management.synthetic@example.invalid',
} as const;

const originalClient: ClientDetail = {
  schemaVersion: 1,
  id: '31200000-0000-4000-8000-000000000002',
  externalReference: 'CLIENTE-MANUAL-312',
  name: 'Cliente Manual Sintético',
  address: 'Rua Sintética, 312',
  latitude: null,
  longitude: null,
  portfolioReference: 'CARTEIRA-312',
  sellerId: seller.id,
  sellerEmail: seller.email,
  status: 'active',
  version: 1,
} as const;

function clientListPayload(allClients: readonly ClientDetail[], url: URL) {
  const query = url.searchParams.get('q')?.trim() ?? '';
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? url.searchParams.get('limit') ?? '25');
  const normalizedQuery = query.toLocaleLowerCase('pt-BR');
  const filtered = query ? allClients.filter((client) => [
    client.externalReference,
    client.name,
    client.address,
    client.portfolioReference ?? '',
  ].some((value) => value.toLocaleLowerCase('pt-BR').includes(normalizedQuery))) : [...allClients];
  const totalPages = Math.ceil(filtered.length / pageSize);
  return {
    schemaVersion: 1 as const,
    query,
    clients: filtered.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      pageSize,
      totalCount: filtered.length,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  };
}

test.describe('manual client management', () => {
  test.use({ serviceWorkers: 'block' });

  test('validates, creates and refreshes the canonical client list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let clients = [originalClient];
    let createCalls = 0;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31200000-0000-4000-8000-000000000003', displayName: 'Gestor Sintético',
          roles: ['manager'], capabilities: ['clients.read', 'clients.manage'], scopeIds: [], status: 'active',
        } });
        return;
      }
      if (pathname === '/api/v1/clients/sellers') {
        await route.fulfill({ json: { schemaVersion: 1, sellers: [seller] } });
        return;
      }
      if (pathname === '/api/v1/clients' && request.method() === 'GET') {
        await route.fulfill({ json: clientListPayload(clients, url) });
        return;
      }
      if (pathname === '/api/v1/clients' && request.method() === 'POST') {
        createCalls += 1;
        const body = request.postDataJSON();
        const created = {
          ...originalClient,
          id: '31200000-0000-4000-8000-000000000004',
          externalReference: body.externalReference,
          name: body.name,
          address: body.address,
          portfolioReference: body.portfolioReference || null,
        };
        clients = [...clients, created];
        await route.fulfill({ status: 201, json: { schemaVersion: 1, replayed: false, client: created } });
        return;
      }
      await route.abort();
    });

    await page.goto('/management/clients');
    await page.getByRole('button', { name: 'Novo cliente' }).click();
    await page.getByRole('button', { name: 'Salvar cliente' }).click();
    await expect(page.getByText('Revise os campos indicados antes de salvar.')).toBeVisible();
    await expect(page.getByLabel('Referência externa')).toBeFocused();

    await page.getByLabel('Referência externa').fill('cliente novo 312');
    await page.getByLabel('Nome').fill('Novo Cliente Sintético');
    await page.getByLabel('Endereço completo').fill('Avenida Sintética, 12');
    await page.getByLabel('Referência de carteira').fill('CARTEIRA-NOVA');
    await page.getByLabel('Vendedor responsável').selectOption(seller.email);
    await page.getByRole('button', { name: 'Salvar cliente' }).click();

    await expect(page.getByText('Cliente salvo e lista atualizada.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Novo Cliente Sintético' })).toBeVisible();
    expect(createCalls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('turns an authorized duplicate into an actionable correction', async ({ page }) => {
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31200000-0000-4000-8000-000000000003', displayName: 'Gestor Sintético',
          roles: ['manager'], capabilities: ['clients.read', 'clients.manage'], scopeIds: [], status: 'active',
        } });
        return;
      }
      if (pathname === '/api/v1/clients/sellers') {
        await route.fulfill({ json: { schemaVersion: 1, sellers: [seller] } });
        return;
      }
      if (pathname === '/api/v1/clients' && request.method() === 'GET') {
        await route.fulfill({ json: clientListPayload([originalClient], url) });
        return;
      }
      if (pathname === '/api/v1/clients' && request.method() === 'POST') {
        await route.fulfill({ status: 409, json: {
          error: {
            code: 'VERSION_CONFLICT', message: 'A referência já pertence a outro cliente.', recoverable: false,
            timestamp: '2026-10-20T12:00:00.000Z',
            requestId: '31200000-0000-4000-8000-000000000007',
            details: { current: originalClient },
          },
        } });
        return;
      }
      await route.abort();
    });

    await page.goto('/management/clients');
    await page.getByRole('button', { name: 'Novo cliente' }).click();
    await page.getByLabel('Referência externa').fill(originalClient.externalReference);
    await page.getByLabel('Nome').fill('Tentativa Duplicada');
    await page.getByLabel('Endereço completo').fill('Rua Duplicada, 1');
    await page.getByLabel('Vendedor responsável').selectOption(seller.email);
    await page.getByRole('button', { name: 'Salvar cliente' }).click();

    const correction = page.getByRole('button', { name: 'Corrigir cadastro existente' });
    await expect(correction).toBeVisible();
    await correction.click();
    await expect(page.getByRole('heading', { name: 'Corrigir cliente' })).toBeVisible();
    await expect(page.getByLabel('Referência externa')).toHaveValue(originalClient.externalReference);
    await expect(page.getByLabel('Referência externa')).toBeDisabled();
    await expect(page.getByLabel('Motivo da correção')).toBeVisible();
  });

  test('preserves edits and offers the canonical state after a version conflict', async ({ page }) => {
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31200000-0000-4000-8000-000000000003', displayName: 'Gestor Sintético',
          roles: ['manager'], capabilities: ['clients.read', 'clients.manage'], scopeIds: [], status: 'active',
        } });
        return;
      }
      if (pathname === '/api/v1/clients/sellers') {
        await route.fulfill({ json: { schemaVersion: 1, sellers: [seller] } });
        return;
      }
      if (pathname === '/api/v1/clients' && request.method() === 'GET') {
        await route.fulfill({ json: clientListPayload([originalClient], url) });
        return;
      }
      if (pathname === `/api/v1/clients/${originalClient.id}` && request.method() === 'PATCH') {
        await route.fulfill({ status: 409, json: {
          error: {
            code: 'VERSION_CONFLICT', message: 'O cliente já foi alterado.', recoverable: false,
            timestamp: '2026-10-19T12:00:00.000Z',
            requestId: '31200000-0000-4000-8000-000000000005',
            details: { current: { ...originalClient, name: 'Nome Concorrente', version: 2 } },
          },
        } });
        return;
      }
      await route.abort();
    });

    await page.goto('/management/clients');
    await page.getByRole('button', { name: 'Editar cliente' }).click();
    await page.getByLabel('Nome').fill('Minha Correção Preservada');
    await page.getByLabel('Motivo da correção').fill('Correção sintética concorrente');
    await page.getByRole('button', { name: 'Salvar cliente' }).click();

    await expect(page.getByText('Estado atual no servidor')).toBeVisible();
    await expect(page.getByLabel('Nome')).toHaveValue('Minha Correção Preservada');
    await page.getByRole('button', { name: 'Carregar estado atual' }).click();
    await expect(page.getByLabel('Nome')).toHaveValue('Nome Concorrente');
    await expect(page.getByText('Versão atual: 2.')).toBeVisible();
  });

  test('finds and opens an authorized client beyond the first hundred records', async ({ page }) => {
    const clients = Array.from({ length: 101 }, (_, index): ClientDetail => ({
      ...originalClient,
      id: `31200000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      externalReference: `CLIENTE-PAGINADO-${String(index + 1).padStart(3, '0')}`,
      name: `Cliente Paginado ${String(index + 1).padStart(3, '0')}`,
    }));
    const target = clients[100]!;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31200000-0000-4000-8000-000000000003', displayName: 'Gestor Sintético',
          roles: ['manager'], capabilities: ['clients.read', 'clients.manage'], scopeIds: [], status: 'active',
        } });
        return;
      }
      if (url.pathname === '/api/v1/clients/sellers') {
        await route.fulfill({ json: { schemaVersion: 1, sellers: [seller] } });
        return;
      }
      if (url.pathname === '/api/v1/clients' && request.method() === 'GET') {
        await route.fulfill({ json: clientListPayload(clients, url) });
        return;
      }
      await route.abort();
    });

    await page.goto('/management/clients');
    await expect(page.getByText('101 clientes encontrados')).toBeVisible();
    await expect(page.getByRole('heading', { name: target.name })).toHaveCount(0);
    await page.getByLabel('Pesquisar clientes').fill(target.externalReference);
    await page.getByRole('button', { name: 'Buscar clientes' }).click();
    await expect(page.getByText('1 cliente encontrado')).toBeVisible();
    await expect(page.getByRole('heading', { name: target.name })).toBeVisible();
    await page.getByRole('button', { name: 'Editar cliente' }).click();
    await expect(page.getByRole('heading', { name: 'Corrigir cliente' })).toBeVisible();
    await expect(page.getByLabel('Referência externa')).toHaveValue(target.externalReference);
  });

  test('shows access denied without exposing management actions', async ({ page }) => {
    await page.route('**/api/v1/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/v1/me') {
        await route.fulfill({ json: {
          id: '31200000-0000-4000-8000-000000000006', displayName: 'Vendedor Sintético',
          roles: ['seller'], capabilities: ['clients.read'], scopeIds: [], status: 'active',
        } });
        return;
      }
      await route.abort();
    });

    await page.goto('/management/clients');
    await expect(page.getByText('Seu perfil não tem acesso à gestão de clientes.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novo cliente' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Importar planilha oficial' })).toHaveCount(0);
  });
});
