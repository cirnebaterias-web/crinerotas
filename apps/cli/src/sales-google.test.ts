import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { salesSheetHeaders } from '@cirne/contracts';
import { createGoogleSalesReader, projectSalesGoogleResponse } from './sales-google';

function googleBody(count = 1) {
  const rows = Array.from({ length: count }, (_, index) => index);
  return { valueRanges: [
    { range: 'Vendas!A1:AL1', majorDimension: 'ROWS', values: [[...salesSheetHeaders]] },
    { range: `Vendas!B2:B${count + 1}`, majorDimension: 'ROWS', values: rows.map(() => ['00000000001']) },
    { range: `Vendas!I2:M${count + 1}`, majorDimension: 'ROWS', values: rows.map(() => ['001', '5/12/2023', 'SKU1', '2', '200,00']) },
    { range: `Vendas!R2:T${count + 1}`, majorDimension: 'ROWS', values: rows.map(() => ['Produto sintético', 'SLI']) },
    { range: `Vendas!AB2:AD${count + 1}`, majorDimension: 'ROWS', values: rows.map(() => ['Leve', 'Marca']) },
    { range: `Vendas!AH2:AH${count + 1}`, majorDimension: 'ROWS', values: rows.map(() => ['Venda']) },
    { range: `Vendas!AL2:AL${count + 1}`, majorDimension: 'ROWS', values: rows.map((index) => [`key-${index}`]) },
  ] };
}
describe('Google sales projection', () => {
  it('preserves sparse range row offsets and never returns costs or seller data', () => {
    const body = googleBody(3);
    body.valueRanges[1]!.values = [['00000000001'], [], ['00000000003']];
    body.valueRanges[4]!.values = [['Leve']];
    const rows = projectSalesGoogleResponse(body);
    expect(rows[2]).toMatchObject({ sourceRow: 4, cells: { clientExternalReference: '00000000003', category: undefined } });
    expect(rows[1]!.cells.clientExternalReference).toBeUndefined();
    expect(Object.keys(rows[0]!.cells)).not.toContain('cost');
  });
  it('rejects missing/rerouted ranges, extra data columns and changed headers', () => {
    const wrongRange = googleBody(); wrongRange.valueRanges[1]!.range = 'Produtos!B2:B2';
    const wrongHeader = googleBody(); wrongHeader.valueRanges[0]!.values[0]![1] = 'Documento';
    const tooWide = googleBody(); tooWide.valueRanges[1]!.values[0]!.push('unexpected');
    for (const body of [wrongRange, wrongHeader, tooWide, { valueRanges: [] }]) {
      expect(() => projectSalesGoogleResponse(body)).toThrow();
    }
  });
  it('handles 26000 synthetic records without truncation', () => {
    const rows = projectSalesGoogleResponse(googleBody(26000));
    expect(rows).toHaveLength(26000); expect(rows.at(-1)!.sourceRow).toBe(26001);
  });
  it('rejects empty and oversized data instead of publishing a partial snapshot', () => {
    expect(() => projectSalesGoogleResponse(googleBody(0))).toThrow();
    const body = googleBody(); body.valueRanges[1]!.values = Array.from({ length: 100001 }, () => ['x']);
    expect(() => projectSalesGoogleResponse(body)).toThrow();
  });
});
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { spreadsheetId: 'synthetic_sheet_identifier_123', email: 'test@synthetic.iam.gserviceaccount.com',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  scheduleEnabled: false, schedulerActorId: '11111111-1111-4111-8111-111111111111' };
describe('Google sales authentication and transport', () => {
  it('signs RS256 readonly assertions and only requests the approved ranges', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'synthetic', token_type: 'Bearer' }))
      .mockResolvedValueOnce(Response.json(googleBody()));
    const reader = await createGoogleSalesReader(config, { transport, clock: () => new Date('2026-11-03T09:15:00Z') });
    await reader();
    const params = transport.mock.calls[0]![1]!.body as URLSearchParams;
    const assertion = params.get('assertion')!; const [header, payload, signature] = assertion.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    const url = new URL(String(transport.mock.calls[1]![0]));
    expect(url.searchParams.getAll('ranges')).toEqual(["'Vendas'!A1:AL1", "'Vendas'!B2:B", "'Vendas'!I2:M", "'Vendas'!R2:T", "'Vendas'!AB2:AD", "'Vendas'!AH2:AH", "'Vendas'!AL2:AL"]);
    expect(transport.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it('backs off boundedly on quota but does not leak provider errors', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private token', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(Response.json({ access_token: 'synthetic', token_type: 'Bearer' }))
      .mockResolvedValueOnce(new Response('private source', { status: 403 }));
    const read = await createGoogleSalesReader(config, { transport, sleep });
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('denies oversized body even with missing Content-Length', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'synthetic', token_type: 'Bearer' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(32 * 1024 * 1024 + 1)));
    const read = await createGoogleSalesReader(config, { transport });
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });
  it('rejects invalid UTF-8 rather than replacing source bytes silently', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'synthetic', token_type: 'Bearer' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 0xff, 34, 125])));
    const read = await createGoogleSalesReader(config, { transport });
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('does not retry permission errors or disregard a long provider cooldown', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private reason', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(createGoogleSalesReader(config, { transport, sleep })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(sleep).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });
});
