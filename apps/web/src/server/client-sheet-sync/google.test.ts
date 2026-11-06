import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { clientSheetHeaders } from '@cirne/contracts';
import { readGoogleClientSheet } from './google';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { spreadsheetId: 'synthetic-sheet-id-000001', email: 'test@synthetic.iam.gserviceaccount.com',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), portfolios: {}, scheduleEnabled: false };
describe('read-only Google adapter', () => {
  it('signs a short-lived RS256 assertion and reads only calculated values of the authorized tab', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'synthetic-token', token_type: 'Bearer' }))
      .mockResolvedValueOnce(Response.json({ values: [clientSheetHeaders] }));
    await expect(readGoogleClientSheet(config, transport, () => new Date('2026-11-03T09:00:00Z'))).resolves.toEqual([clientSheetHeaders]);
    const body = transport.mock.calls[0]![1]!.body as URLSearchParams;
    const [header, payload, signature] = body.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(decodeURIComponent(String(transport.mock.calls[1]![0]))).toContain("'Base clientes'!A:U");
    expect(String(transport.mock.calls[1]![0])).toContain('valueRenderOption=FORMATTED_VALUE');
    expect(transport.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it.each([401, 403, 429, 500])('redacts provider errors %d', async (status) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret provider payload', { status }));
    await expect(readGoogleClientSheet(config, transport)).rejects.toThrow('Confira a credencial');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed JSON, large replies, too many rows and network errors', async () => {
    for (const response of [new Response('not json'), Response.json({ values: Array.from({ length: 5002 }, () => []) }),
      new Response('x'.repeat(5 * 1024 * 1024 + 1))]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'test', token_type: 'Bearer' })).mockResolvedValueOnce(response);
      await expect(readGoogleClientSheet(config, transport)).rejects.toThrow('Não foi possível ler');
    }
    await expect(readGoogleClientSheet(config, vi.fn().mockRejectedValue(new Error('secret network details')))).rejects.toThrow('Não foi possível ler');
  });
  it('never sends a malformed private key to the network', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(readGoogleClientSheet({ ...config, privateKey: 'invalid' }, transport)).rejects.toThrow('Não foi possível ler');
    expect(transport).not.toHaveBeenCalled();
  });
});
