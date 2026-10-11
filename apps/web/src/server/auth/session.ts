import type { SupabaseClient } from '@supabase/supabase-js';
import { meResponseSchema, type LoginRequest } from '@cirne/contracts';
import { IdentityRequestError, loadCallerIdentity } from '../identity';

export async function signInOperator(client: SupabaseClient, credentials: LoginRequest) {
  const { error } = await client.auth.signInWithPassword(credentials);
  if (error) {
    if (!error.status || error.status === 429 || error.status >= 500) {
      throw new IdentityRequestError(503, 'identity_unavailable', 'Acesso temporariamente indisponível.', true);
    }
    throw new IdentityRequestError(401, 'authentication_required', 'Confira suas credenciais e seu acesso.', true);
  }
  const resolved = await loadCallerIdentity(client);
  const identity = meResponseSchema.safeParse(resolved.identity);
  const allowed = identity.success && identity.data.id === resolved.userId && identity.data.status === 'active' && (
    (identity.data.roles.includes('seller') && identity.data.capabilities.includes('route.read_self')) ||
    (identity.data.roles.includes('manager') && identity.data.capabilities.includes('route.plan_scoped')) ||
    (identity.data.roles.some((role) => ['logistics', 'manager', 'administrator'].includes(role)) &&
      identity.data.capabilities.includes('scrap.read_operations'))
  );
  if (!allowed || !identity.success) {
    try { await client.auth.signOut({ scope: 'local' }); }
    catch { /* The handler discards the provisional session and clears incoming cookies. */ }
    throw new IdentityRequestError(403, 'access_denied', 'Confira suas credenciais e seu acesso.', false);
  }
  return identity.data;
}
