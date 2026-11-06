import {
  apiErrorResponseSchema, sellerRouteProfileMutationResponseSchema, sellerRouteProfilePath,
  sellerRouteProfileSchema, updateSellerRouteProfileRequestSchema,
  type UpdateSellerRouteProfileRequest,
} from '@cirne/contracts';
import { z } from 'zod';
import { safeSyncOrigin } from './client-sheet-sync';

export class SellerRouteProfileCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

async function call(baseUrl: string, token: string, path: string, init: RequestInit,
  request: typeof fetch) {
  const origin = safeSyncOrigin(baseUrl);
  let response: Response;
  try {
    response = await request(new URL(path, origin), { ...init, cache: 'no-store', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(10_000) });
  } catch { throw new SellerRouteProfileCliError(69, 'Perfil operacional temporariamente indisponivel.'); }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    throw new SellerRouteProfileCliError(response.status === 403 ? 77 : response.status === 409 ? 78
      : response.status === 422 ? 64 : 69, error.success ? error.data.error.message : 'Falha no perfil operacional.');
  }
  return body;
}

export async function getSellerRouteProfile(baseUrl: string, token: string, sellerId: string,
  request: typeof fetch = fetch) {
  const id = z.uuid().parse(sellerId);
  return sellerRouteProfileSchema.parse(await call(baseUrl, token, sellerRouteProfilePath(id), {}, request));
}

export async function updateSellerRouteProfile(baseUrl: string, token: string, sellerId: string,
  command: UpdateSellerRouteProfileRequest, request: typeof fetch = fetch) {
  const id = z.uuid().parse(sellerId);
  const parsed = updateSellerRouteProfileRequestSchema.parse(command);
  return sellerRouteProfileMutationResponseSchema.parse(await call(baseUrl, token, sellerRouteProfilePath(id),
    { method: 'PUT', body: JSON.stringify(parsed) }, request));
}
