import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import { createCallerScopedClient, IdentityRequestError, resolveIdentityRequest } from '../../server/identity';
import { getVisitDetail, VisitServiceFailure } from '../../server/visits/service';
import { SupabaseVisitRepository } from '../../server/visits/supabase-repository';
import { VisitDetailDashboard, type VisitDetailInitialState } from './visit-detail-dashboard';

export async function VisitDetailPage({ visitId }: { visitId: string }) {
  let initial: VisitDetailInitialState;
  try {
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: () => { /* Server Components cannot persist refreshed cookies. */ },
    };
    const identity = await resolveIdentityRequest(null, cookieMethods);
    const client = createCallerScopedClient(null, cookieMethods);
    initial = { kind: 'ready', result: await getVisitDetail(
      identity, visitId, crypto.randomUUID(), new SupabaseVisitRepository(client),
    ) };
  } catch (error) {
    const forbidden = (error instanceof IdentityRequestError && [401, 403].includes(error.status)) ||
      (error instanceof VisitServiceFailure && ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'].includes(error.code));
    initial = forbidden
      ? { kind: 'forbidden', visitId, message: 'A visita não foi encontrada no seu escopo.' }
      : { kind: 'recoverable_error', visitId, message: 'O detalhe está temporariamente indisponível. Tente novamente.' };
  }
  return <VisitDetailDashboard initial={initial} />;
}
