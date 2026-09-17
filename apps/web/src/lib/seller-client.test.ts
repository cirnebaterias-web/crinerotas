import { afterEach, expect, it, vi } from 'vitest';
import { loginRequestSchema } from '@cirne/contracts';
import { isSessionFailure, sellerClient, SellerHttpError } from './seller-client';

afterEach(() => { vi.unstubAllGlobals(); });

it('bounds and validates login credentials without silently trimming a password', () => {
  expect(loginRequestSchema.parse({ email: '  seller@example.test  ', password: ' keep spaces ' })).toEqual({ email: 'seller@example.test', password: ' keep spaces ' });
  expect(loginRequestSchema.safeParse({ email: 'invalid', password: 'x' }).success).toBe(false);
  expect(loginRequestSchema.safeParse({ email: 'seller@example.test', password: 'x'.repeat(257) }).success).toBe(false);
  expect(loginRequestSchema.safeParse({ email: 'seller@example.test', password: 'x', token: 'extra' }).success).toBe(false);
});

it('uses same-origin/no-store fetches with a deadline and validates payloads', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 2, availability: 'empty', serviceDate: '2026-09-16' })));
  vi.stubGlobal('fetch', fetcher);
  expect(await sellerClient.today()).toMatchObject({ availability: 'empty' });
  expect(fetcher).toHaveBeenCalledWith('/api/v1/me/routes/today', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }));
  fetcher.mockResolvedValue(new Response(JSON.stringify({ availability: 'empty' })));
  await expect(sellerClient.today()).rejects.toThrow();
});

it('classifies access failures separately from concurrency and server errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 409 })));
  await expect(sellerClient.today()).rejects.toMatchObject({ status: 409 });
  expect(isSessionFailure(new SellerHttpError(401))).toBe(true);
  expect(isSessionFailure(new SellerHttpError(403))).toBe(true);
  expect(isSessionFailure(new SellerHttpError(409))).toBe(false);
  expect(isSessionFailure(new TypeError('Failed to fetch'))).toBe(false);
});
