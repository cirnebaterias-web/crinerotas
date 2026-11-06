import { describe, expect, it, vi } from 'vitest';
import { clientSheetSyncCommand, loginSheetSyncOperator, safeSyncOrigin } from './client-sheet-sync';
const status = { configured: false, reason: 'disabled', scheduleEnabled: false,
  timeZone: 'America/Sao_Paulo', times: ['06:00', '13:00'], latest: null };
describe('sheet sync CLI transport', () => {
  it.each(['http://remote.example', 'https://user:password@example.test', 'https://example.test/path',
    'https://example.test/?q=1', 'https://example.test/#x', 'file:///etc/passwd'])('rejects unsafe origin %s', (url) => {
    expect(() => safeSyncOrigin(url)).toThrow();
  });
  it('queries status using caller token without following redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(status));
    expect(await clientSheetSyncCommand('http://127.0.0.1:3000', 'synthetic', null, transport)).toEqual(status);
    expect(transport).toHaveBeenCalledWith(new URL('http://127.0.0.1:3000/api/v1/client-sync'), expect.objectContaining({
      method: 'GET', redirect: 'error', headers: { authorization: 'Bearer synthetic' },
    }));
  });
  it('sends the manual key verbatim for idempotent retries', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream body', { status: 503 }));
    const command = { trigger: 'manual', idempotencyKey: '31300000-0000-4000-8000-000000000001' } as const;
    await expect(clientSheetSyncCommand('https://app.example.test', 'synthetic', command, transport)).rejects.toThrow('HTTP 503');
    expect(transport).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'POST', body: JSON.stringify(command) }));
  });
  it('fails closed for incomplete scheduler configuration without echoing values', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(loginSheetSyncOperator({ CIRNE_SHEET_SYNC_PASSWORD: 'private-input' }, transport)).rejects.toThrow('Configure a identidade');
    expect(transport).not.toHaveBeenCalled();
  });
  it('authenticates the dedicated account without service-role or redirects', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'synthetic-session' }));
    const token = await loginSheetSyncOperator({ SUPABASE_PUBLIC_URL: 'https://db.example.test',
      SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key-123456', CIRNE_SHEET_SYNC_EMAIL: 'operator@example.invalid',
      CIRNE_SHEET_SYNC_PASSWORD: 'synthetic-password-1234' }, transport);
    expect(token).toBe('synthetic-session');
    expect(transport).toHaveBeenCalledWith('https://db.example.test/auth/v1/token?grant_type=password',
      expect.objectContaining({ method: 'POST', redirect: 'error' }));
  });
});
