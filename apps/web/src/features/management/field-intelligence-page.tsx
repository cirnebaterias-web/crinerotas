import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import { readServerConfig } from '@cirne/config/server';
import type { FieldIntelligenceFilter } from '@cirne/contracts';
import { createCallerScopedClient, IdentityRequestError, resolveIdentityRequest } from '../../server/identity';
import { currentFieldIntelligenceWeek, getFieldIntelligence, normalizeFieldIntelligenceFilters } from '../../server/field-intelligence/service';
import { SupabaseFieldIntelligenceRepository } from '../../server/field-intelligence/supabase-repository';
import { RouteServiceFailure } from '../../server/routes/service';
import { FieldIntelligenceDashboard, type FieldIntelligenceInitialState } from './field-intelligence-dashboard';

type IntelligenceSearchParams = Record<string, string | string[] | undefined>;

export async function FieldIntelligencePage({ searchParams }: { searchParams: Promise<IntelligenceSearchParams> }) {
  const parameters = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  let selectedFilters: FieldIntelligenceFilter = { section: 'stock', from: today, to: today };
  let initial: FieldIntelligenceInitialState;
  let timeZone: string | undefined;
  try {
    timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    selectedFilters = { section: 'stock', ...currentFieldIntelligenceWeek(timeZone) };
    const keys = ['section', 'from', 'to', 'sellerId', 'clientId', 'competitorId', 'actionType', 'cursor'] as const;
    if (keys.some((key) => Array.isArray(parameters[key]))) {
      throw new RouteServiceFailure('VALIDATION_FAILED', 'Cada filtro deve ser informado uma única vez.', false);
    }
    const filterInput = Object.fromEntries(keys.map((key) => [key, parameters[key] as string | undefined]));
    filterInput.section ??= 'stock';
    const filters = normalizeFieldIntelligenceFilters(filterInput, timeZone);
    selectedFilters = filters;
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: () => { /* Server Components cannot persist refreshed cookies. */ },
    };
    const identity = await resolveIdentityRequest(null, cookieMethods);
    const client = createCallerScopedClient(null, cookieMethods);
    const result = await getFieldIntelligence(identity, filters, timeZone, new SupabaseFieldIntelligenceRepository(client));
    initial = { kind: result.records.length === 0 ? 'empty' : 'ready', filters, result };
  } catch (error) {
    const forbidden = (error instanceof IdentityRequestError && [401, 403].includes(error.status)) ||
      (error instanceof RouteServiceFailure && error.code === 'FORBIDDEN');
    const message = error instanceof RouteServiceFailure && error.code === 'VALIDATION_FAILED'
      ? error.message
      : forbidden ? 'Seu perfil não tem acesso à Inteligência de Campo.'
        : 'A Inteligência de Campo está temporariamente indisponível. Tente novamente.';
    initial = { kind: forbidden ? 'forbidden' : 'recoverable_error', filters: selectedFilters, message };
  }
  const key = initial.kind === 'ready' || initial.kind === 'empty'
    ? `${initial.result.section}:${initial.result.generatedAt}` : `${initial.filters.section}:${initial.kind}`;
  return <FieldIntelligenceDashboard key={key} initial={initial} timeZone={timeZone} />;
}
