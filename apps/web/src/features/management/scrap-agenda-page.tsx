import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import { readServerConfig } from '@cirne/config/server';
import type { ScrapAgendaFilter } from '@cirne/contracts';
import { createCallerScopedClient, IdentityRequestError, resolveIdentityRequest } from '../../server/identity';
import { getScrapAgenda, normalizeScrapAgendaFilters } from '../../server/scrap-agenda/service';
import { SupabaseScrapAgendaRepository } from '../../server/scrap-agenda/supabase-repository';
import { RouteServiceFailure } from '../../server/routes/service';
import { ScrapAgendaDashboard, type ScrapAgendaInitialState } from './scrap-agenda-dashboard';

type AgendaSearchParams = Record<string, string | string[] | undefined>;

export async function ScrapAgendaPage({ searchParams }: { searchParams: Promise<AgendaSearchParams> }) {
  const parameters = await searchParams;
  const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
  const keys = ['from', 'to', 'status', 'period', 'sellerId', 'clientId', 'cursor'] as const;
  const allowedKeys = new Set<string>(keys);
  let selectedFilters: ScrapAgendaFilter = normalizeScrapAgendaFilters({}, timeZone);
  let initial: ScrapAgendaInitialState;
  try {
    if (Object.keys(parameters).some((key) => !allowedKeys.has(key)) ||
        keys.some((key) => Array.isArray(parameters[key]))) {
      throw new RouteServiceFailure('VALIDATION_FAILED', 'Filtro da agenda inválido ou repetido.', false);
    }
    const filterInput = Object.fromEntries(keys.map((key) => [key, parameters[key] as string | undefined]));
    const filters = normalizeScrapAgendaFilters(filterInput, timeZone);
    selectedFilters = filters;
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: () => { /* Server Components cannot persist refreshed cookies. */ },
    };
    const identity = await resolveIdentityRequest(null, cookieMethods);
    const client = createCallerScopedClient(null, cookieMethods);
    const result = await getScrapAgenda(identity, filters, new SupabaseScrapAgendaRepository(client));
    initial = { kind: result.records.length === 0 ? 'empty' : 'ready', filters, result };
  } catch (error) {
    const forbidden = (error instanceof IdentityRequestError && [401, 403].includes(error.status)) ||
      (error instanceof RouteServiceFailure && error.code === 'FORBIDDEN');
    const message = error instanceof RouteServiceFailure && error.code === 'VALIDATION_FAILED'
      ? error.message
      : forbidden ? 'Seu perfil não tem acesso à agenda de sucata.'
        : 'A agenda de sucata está temporariamente indisponível. Tente novamente.';
    initial = { kind: forbidden ? 'forbidden' : 'recoverable_error', filters: selectedFilters, message };
  }
  const key = initial.kind === 'ready' || initial.kind === 'empty'
    ? initial.result.generatedAt : `${initial.filters.from}:${initial.kind}`;
  return <ScrapAgendaDashboard key={key} initial={initial} operationalTimeZone={timeZone} />;
}
