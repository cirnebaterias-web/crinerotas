import { describe, expect, it, vi } from 'vitest';
import { clientPath, clientsPath } from '@cirne/contracts';
import { runClientManagementRoundTrip } from './clients';

const clientId = '10000000-0000-4000-8000-000000000099';
const sellerId = '20000000-0000-4000-8000-000000000099';
const sellerEmail = 'seller@example.invalid';

function canonical(version: number, name: string) {
  return {
    schemaVersion: 1, id: clientId, externalReference: 'CLI-REFERENCE', name,
    address: 'Rua Sintética CLI, 10', latitude: null, longitude: null,
    portfolioReference: 'CLI', sellerId, sellerEmail, status: 'active', version,
  };
}

describe('client management CLI', () => {
  it('confirms create, replay, query, update and stale conflict without exposing the token', async () => {
    let posts = 0;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === clientsPath && init?.method === 'POST') {
        posts += 1;
        return Response.json({ schemaVersion: 1, replayed: posts > 1,
          client: canonical(1, 'Cliente sintético CLI') }, { status: posts > 1 ? 200 : 201 });
      }
      if (url.pathname === clientPath(clientId) && !init?.method) return Response.json(canonical(1, 'Cliente sintético CLI'));
      if (url.pathname === clientPath(clientId) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { name: string };
        if (body.name.includes('obsoleta')) return Response.json({ error: { code: 'VERSION_CONFLICT' } }, { status: 409 });
        return Response.json({ schemaVersion: 1, replayed: false,
          client: canonical(2, 'Cliente sintético CLI corrigido') });
      }
      return Response.json({}, { status: 404 });
    });
    const result = await runClientManagementRoundTrip('http://127.0.0.1:3000', 'private-token', sellerEmail, request);
    expect(result).toMatchObject({ schemaVersion: 1, status: 'ok', clientId, updatedVersion: 2,
      checks: { created: true, replayed: true, queried: true, updated: true, staleConflict: true } });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('fails when the server does not mark the repeated creation as replayed', async () => {
    const request = vi.fn(async () => Response.json({
      schemaVersion: 1, replayed: false, client: canonical(1, 'Cliente sintético CLI'),
    }));
    await expect(runClientManagementRoundTrip('http://127.0.0.1:3000', 'private-token', sellerEmail, request))
      .rejects.toThrow('Reenvio idempotente');
  });
});
