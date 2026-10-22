import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import { managementServiceDateSchema } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createCallerScopedClient, IdentityRequestError, resolveIdentityRequest } from '../../server/identity';
import { getManagementDay, managementCurrentDate } from '../../server/management-day/service';
import { SupabaseManagementDayRepository } from '../../server/management-day/supabase-repository';
import { RouteServiceFailure } from '../../server/routes/service';
import { ManagementDayDashboard, type ManagementDayInitialState } from './management-day-dashboard';

export async function ManagementDayPage({
  searchParams,
}: {
  searchParams: Promise<{ serviceDate?: string | string[] }>;
}) {
  const parameters = await searchParams;
  let fallbackDate = new Date().toISOString().slice(0, 10);
  let selectedDate = fallbackDate;
  let initial: ManagementDayInitialState;
  try {
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    fallbackDate = managementCurrentDate(timeZone);
    selectedDate = fallbackDate;
    const supplied = Array.isArray(parameters.serviceDate) ? null : parameters.serviceDate;
    const parsed = supplied === undefined
      ? { success: true as const, data: fallbackDate }
      : managementServiceDateSchema.safeParse(supplied);
    if (!parsed.success) {
      initial = { kind: 'recoverable_error', serviceDate: fallbackDate,
        message: 'A data informada na URL é inválida. Selecione uma data válida.' };
    } else {
      selectedDate = parsed.data;
      const store = await cookies();
      const cookieMethods: CookieMethodsServer = {
        getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
        setAll: () => { /* Server Components cannot persist refreshed cookies. */ },
      };
      const identity = await resolveIdentityRequest(null, cookieMethods);
      const client = createCallerScopedClient(null, cookieMethods);
      const result = await getManagementDay(
        identity, parsed.data, timeZone, new SupabaseManagementDayRepository(client),
      );
      initial = { kind: result.availability === 'empty' ? 'empty' : 'ready',
        serviceDate: parsed.data, result };
    }
  } catch (error) {
    const forbidden = (error instanceof IdentityRequestError && [401, 403].includes(error.status)) ||
      (error instanceof RouteServiceFailure && error.code === 'FORBIDDEN');
    initial = forbidden
      ? { kind: 'forbidden', serviceDate: selectedDate, message: 'Seu perfil não tem acesso à visão gerencial.' }
      : { kind: 'recoverable_error', serviceDate: selectedDate,
        message: 'A visão gerencial está temporariamente indisponível. Tente novamente.' };
  }
  const dashboardKey = initial.kind === 'ready' || initial.kind === 'empty'
    ? `${initial.serviceDate}:${initial.result.generatedAt}`
    : `${initial.serviceDate}:${initial.kind}`;
  return <ManagementDayDashboard key={dashboardKey} initial={initial} />;
}
