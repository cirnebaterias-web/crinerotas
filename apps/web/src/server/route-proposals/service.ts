import { clientListResponseSchema, dailySellerLocationSchema, decideWeeklyRouteProposalRequestSchema,
  persistedWeeklyRouteProposalSchema, reviseWeeklyRouteProposalRequestSchema,
  regenerateWeeklyRouteProposalRequestSchema, saveWeeklyRouteProposalRequestSchema,
  sellerRouteProfileSchema, weeklyRouteProposalMutationRequestSchema,
  weeklyRouteProposalMutationResponseSchema, weeklyRouteProposalRequestSchema,
  weeklyRoutePlanningResponseSchema, weeklyRouteProposalSchema, weeklyRouteVisitCoverageResponseSchema,
  type DecideWeeklyRouteProposalRequest, type ImportedClient,
  type ReviseWeeklyRouteProposalRequest,
  type WeeklyRouteProposalMutationRequest, type WeeklyRouteProposalRequest } from '@cirne/contracts';
import { analyzeWeeklyRouteCandidate, maxDailyLegDistanceKm, proposeWeeklyRoutes, SellerBaseCityNotConfiguredError,
  weeklyProposalReadiness } from '@cirne/domain';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { clientImportRpc } from '../client-imports/http';
import { getSalesSignals } from '../client-sales/crm';
import { RouteRequestError } from '../routes/http';
import { getScrapLedgerAnalytics } from '../scrap-ledger-sync/service';
import { listManagedClientSellers } from '../clients/service';

const scrapPageSchema = z.object({
  generationId: z.uuid().nullable(), view: z.literal('balances'), page: z.number().int().positive(),
  pageSize: z.literal(50), totalCount: z.number().int().nonnegative(),
  rows: z.array(z.object({ client_external_reference: z.string().regex(/^(?:\d{11}|\d{14})$/),
    balance_kg: z.union([z.string(), z.number()]), trend: z.enum(['growing', 'falling', 'stable']) }).passthrough()),
  trendMethod: z.string(),
}).strip();
const scrapGenerationSchema = z.object({ generationId: z.uuid(),
  publishedAt: z.iso.datetime({ offset: true }) }).strict();
const coverageRank = { overdue: 0, never_visited: 1, due_this_week: 2,
  covered: 3, unavailable: 4 } as const;
const mutationReplayIntentSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  operation: z.enum(['save', 'regenerate']),
  targetId: z.uuid().nullable(),
  expectedVersion: z.number().int().positive().nullable(),
  sellerId: z.uuid(),
  weekStart: z.iso.date(),
}).strict();

function dateInSaoPaulo(instant: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function listPortfolio(client: SupabaseClient, sellerId: string) {
  const clients: ImportedClient[] = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const result = clientListResponseSchema.parse(await clientImportRpc(client, 'list_management_clients', {
      p_query: '', p_page: page, p_page_size: 100, p_seller_id: sellerId,
    }));
    totalPages = result.pagination.totalPages;
    clients.push(...result.clients);
    if (clients.length > 5000) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Carteira excede o limite da proposta.', false);
  }
  return clients;
}

async function readSignals(client: SupabaseClient, sellerId: string, serviceDate: string, clients: ImportedClient[], now: Date) {
  const byId = new Map<string, Awaited<ReturnType<typeof getSalesSignals>>['signals'][number]['metrics']>();
  let generationId: string | undefined;
  let asOfDate: string | undefined;
  for (let index = 0; index < clients.length; index += 50) {
    const result = await getSalesSignals(client, { sellerId, serviceDate,
      clientIds: clients.slice(index, index + 50).map(({ id }) => id), generationId, asOfDate }, now);
    generationId ??= result.generationId;
    asOfDate ??= result.asOfDate;
    result.signals.forEach(({ client: customer, metrics }) => byId.set(customer.id, metrics));
  }
  return { byId, generationId: generationId ?? null, asOfDate: asOfDate ?? null };
}

async function readScrapDebts(client: SupabaseClient) {
  const debts = new Map<string, { debtKg: number; state: 'debtor' | 'creditor' | 'settled' }>();
  try {
    const first = scrapPageSchema.parse(await getScrapLedgerAnalytics(client, 'balances', '', 1));
    const metadata = scrapGenerationSchema.parse(await clientImportRpc(client, 'get_scrap_ledger_generation_metadata'));
    if (metadata.generationId !== first.generationId) throw new Error('scrap_generation_changed');
    const pages = Math.ceil(first.totalCount / first.pageSize);
    const all = [first];
    for (let page = 2; page <= pages; page += 1) {
      const next = scrapPageSchema.parse(await getScrapLedgerAnalytics(client, 'balances', '', page));
      if (next.generationId !== first.generationId) throw new Error('scrap_generation_changed');
      all.push(next);
    }
    all.flatMap(({ rows }) => rows).forEach((row) => { const balance = Number(row.balance_kg);
      debts.set(row.client_external_reference, { debtKg: Math.max(0, -balance),
        state: balance < 0 ? 'debtor' : balance > 0 ? 'creditor' : 'settled' }); });
    return { debts, status: 'available' as const, generationId: first.generationId,
      publishedAt: metadata.publishedAt };
  } catch {
    // Sales opportunity remains usable; null explicitly represents unavailable scrap data.
    return { debts, status: 'unavailable' as const, generationId: null, publishedAt: null };
  }
}

async function readVisitCoverage(client: SupabaseClient, sellerId: string) {
  try {
    const result = weeklyRouteVisitCoverageResponseSchema.parse(await clientImportRpc(client,
      'list_seller_client_visit_coverage', { p_seller_id: sellerId }));
    return { status: 'available' as const, asOfDate: dateInSaoPaulo(result.observedAt),
      byId: new Map(result.clients.map((item) => [item.clientId, item.lastCompletedVisitAt])) };
  } catch {
    return { status: 'unavailable' as const, asOfDate: null,
      byId: new Map<string, string | null>() };
  }
}

export async function generateWeeklyProposal(client: SupabaseClient, command: WeeklyRouteProposalRequest, now = new Date()) {
  const parsed = weeklyRouteProposalRequestSchema.parse(command);
  const seller = (await listManagedClientSellers(client)).sellers.find(({ id }) => id === parsed.sellerId);
  if (!seller) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Vendedor não encontrado.', false);
  let origin;
  try {
    const persisted = sellerRouteProfileSchema.parse(await clientImportRpc(client, 'get_seller_route_profile', {
      p_seller_id: parsed.sellerId,
    }));
    const readiness = weeklyProposalReadiness(persisted, now);
      if (!readiness.ready) {
        const messages = {
          portfolio_unassigned: 'A carteira está sem titular.',
          seller_inactive: 'O desligamento do vendedor já entrou em vigor.',
          base_city_missing: 'A cidade-base do vendedor ainda não foi configurada.',
        } as const;
        throw new SellerBaseCityNotConfiguredError(messages[readiness.reason]);
      }
    origin = readiness.origin;
  } catch (error) {
    if (error instanceof SellerBaseCityNotConfiguredError) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', error.message, false);
    }
    throw error;
  }
  const portfolio = await listPortfolio(client, parsed.sellerId);
  const [signals, debts, visits] = await Promise.all([
    readSignals(client, parsed.sellerId, parsed.weekStart, portfolio, now), readScrapDebts(client),
    readVisitCoverage(client, parsed.sellerId),
  ]);
  return weeklyRouteProposalSchema.parse(proposeWeeklyRoutes({ weekStart: parsed.weekStart,
    generatedAt: now.toISOString(), origin, strategyPreference: parsed.strategyPreference,
    sources: { sales: { status: signals.generationId ? 'available' : 'unavailable',
      generationId: signals.generationId, asOfDate: signals.asOfDate },
      scrap: { status: debts.status, generationId: debts.generationId, publishedAt: debts.publishedAt },
      visits: { status: visits.status, asOfDate: visits.asOfDate } },
    candidates: portfolio.map((customer) => {
      const metrics = signals.byId.get(customer.id);
      return { clientId: customer.id, name: customer.name,
        status: customer.status === 'active' ? 'active' : 'inactive',
        daysSinceLastPurchase: metrics?.daysSinceLastPurchase ?? null,
        periodicityDays: metrics?.periodicityDays ?? null,
        averageMonthlyVolume: metrics?.averageMonthlyVolume ?? null,
        recentVolume3: metrics?.recentVolume3 ?? null,
        previousVolume3: metrics?.previousVolume3 ?? null,
        opportunitySegments: metrics?.opportunitySegments ?? [],
        scrapDebtKg: debts.debts.get(customer.externalReference)?.debtKg ?? null,
        scrapBalanceState: debts.debts.get(customer.externalReference)?.state ?? 'unavailable',
        location: customer.latitude !== null && customer.longitude !== null
          ? { latitude: customer.latitude, longitude: customer.longitude } : null,
        hasNavigableAddress: Boolean(customer.googleLocation?.placeId || customer.googleLocation?.address || customer.address.trim()),
        visitHistoryStatus: visits.status,
        lastCompletedVisitAt: visits.byId.get(customer.id) ?? null,
      };
    }) }));
}

export async function getWeeklyRoutePlanningCandidates(client: SupabaseClient,
  command: WeeklyRouteProposalRequest, now = new Date()) {
  const parsed = weeklyRouteProposalRequestSchema.parse(command);
  const seller = (await listManagedClientSellers(client)).sellers.find(({ id }) => id === parsed.sellerId);
  if (!seller) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Vendedor não encontrado.', false);
  const persisted = sellerRouteProfileSchema.parse(await clientImportRpc(client, 'get_seller_route_profile', {
    p_seller_id: parsed.sellerId,
  }));
  const readiness = weeklyProposalReadiness(persisted, now);
  if (!readiness.ready) {
    const messages = { portfolio_unassigned: 'A carteira está sem titular.',
      seller_inactive: 'O desligamento do vendedor já entrou em vigor.',
      base_city_missing: 'A cidade-base do vendedor ainda não foi configurada.' } as const;
    throw new RouteRequestError(422, 'VALIDATION_FAILED', messages[readiness.reason], false);
  }
  const origin = readiness.origin;
  const portfolio = await listPortfolio(client, parsed.sellerId);
  const [signals, debts, visits] = await Promise.all([
    readSignals(client, parsed.sellerId, parsed.weekStart, portfolio, now), readScrapDebts(client),
    readVisitCoverage(client, parsed.sellerId),
  ]);
  const all = portfolio.map((customer) => {
    const metrics = signals.byId.get(customer.id);
    return { clientId: customer.id, name: customer.name,
      status: customer.status === 'active' ? 'active' as const : 'inactive' as const,
      daysSinceLastPurchase: metrics?.daysSinceLastPurchase ?? null,
      periodicityDays: metrics?.periodicityDays ?? null,
      averageMonthlyVolume: metrics?.averageMonthlyVolume ?? null,
      recentVolume3: metrics?.recentVolume3 ?? null,
      previousVolume3: metrics?.previousVolume3 ?? null,
      opportunitySegments: metrics?.opportunitySegments ?? [],
      scrapDebtKg: debts.debts.get(customer.externalReference)?.debtKg ?? null,
      scrapBalanceState: debts.debts.get(customer.externalReference)?.state ?? 'unavailable' as const,
      location: customer.latitude !== null && customer.longitude !== null
        ? { latitude: customer.latitude, longitude: customer.longitude } : null,
      hasNavigableAddress: Boolean(customer.googleLocation?.placeId
        || customer.googleLocation?.address || customer.address.trim()),
      visitHistoryStatus: visits.status,
      lastCompletedVisitAt: visits.byId.get(customer.id) ?? null };
  });
  const eligible = all.filter((candidate) => candidate.status === 'active'
    && candidate.daysSinceLastPurchase !== null && candidate.daysSinceLastPurchase <= 180
    && (candidate.location !== null || candidate.hasNavigableAddress));
  const candidates = eligible.map((candidate) => {
    const analysis = analyzeWeeklyRouteCandidate(candidate, origin, parsed.weekStart);
    return { ...candidate, score: analysis.score, distanceFromBaseKm: analysis.distance,
      cycleDelayDays: analysis.cycleDelayDays, cycleDelayPercent: analysis.cycleDelayPercent,
      purchaseTrend: analysis.purchaseTrend, potential: analysis.potential,
      coverageState: analysis.coverageState, coverageOverdueDays: analysis.coverageOverdueDays,
      nextVisitDueOn: analysis.nextVisitDueOn, reasons: analysis.reasons };
  }).sort((left, right) => coverageRank[left.coverageState] - coverageRank[right.coverageState]
    || (right.coverageOverdueDays ?? 0) - (left.coverageOverdueDays ?? 0)
    || right.score - left.score || left.name.localeCompare(right.name, 'pt-BR'));
  return weeklyRoutePlanningResponseSchema.parse({ schemaVersion: 1, weekStart: parsed.weekStart,
    sellerId: parsed.sellerId, origin, generatedAt: now.toISOString(), maxLegDistanceKm: maxDailyLegDistanceKm,
    candidates, counts: { total: all.length, eligible: candidates.length,
      positioned: candidates.filter(({ location }) => location !== null).length,
      inactiveLost: all.filter(({ daysSinceLastPurchase }) =>
        daysSinceLastPurchase !== null && daysSinceLastPurchase > 180).length } });
}

export async function generateAndSaveWeeklyProposal(client: SupabaseClient,
  command: WeeklyRouteProposalRequest & { idempotencyKey: string }, now = new Date()) {
  const proposal = await generateWeeklyProposal(client, {
    schemaVersion: command.schemaVersion, weekStart: command.weekStart, sellerId: command.sellerId,
    strategyPreference: command.strategyPreference,
  }, now);
  const persistenceCommand = saveWeeklyRouteProposalRequestSchema.parse({
    schemaVersion: 1, idempotencyKey: command.idempotencyKey, proposal,
  });
  return persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client, 'save_weekly_route_proposal', {
    p_command: persistenceCommand,
  }));
}

async function readActiveWeeklyProposal(client: SupabaseClient, sellerId: string, weekStart: string) {
  return persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client,
    'get_active_weekly_route_proposal', { p_seller_id: sellerId, p_week_start: weekStart }));
}

function proposalConflict(error: unknown) {
  if (error instanceof RouteRequestError && error.status === 409 && error.code === 'VERSION_CONFLICT') {
    return new RouteRequestError(409, 'VERSION_CONFLICT',
      'A sugestão desta semana foi alterada. Reabra a versão atual antes de continuar.', false,
      error.details);
  }
  return error;
}

async function readMutationReplay(client: SupabaseClient,
  command: z.infer<typeof weeklyRouteProposalMutationRequestSchema>) {
  const intent = mutationReplayIntentSchema.parse({
    schemaVersion: 1,
    idempotencyKey: command.idempotencyKey,
    operation: command.operation === 'regenerate' ? 'regenerate' : 'save',
    targetId: command.operation === 'regenerate' ? command.proposalId! : null,
    expectedVersion: command.operation === 'regenerate' ? command.expectedVersion! : null,
    sellerId: command.sellerId,
    weekStart: command.weekStart,
  });
  const replay = await clientImportRpc(client, 'get_weekly_route_proposal_mutation_replay', {
    p_command: intent,
  });
  return replay === null ? null : persistedWeeklyRouteProposalSchema.parse(replay);
}

export async function mutateWeeklyProposal(client: SupabaseClient,
  command: WeeklyRouteProposalMutationRequest, now = new Date()) {
  const parsed = weeklyRouteProposalMutationRequestSchema.parse(command);
  const replay = await readMutationReplay(client, parsed);
  if (replay) return weeklyRouteProposalMutationResponseSchema.parse({ schemaVersion: 1,
    outcome: parsed.operation === 'regenerate' ? 'regenerated' : 'created', record: replay });
  if (parsed.operation === 'open_or_generate') {
    try {
      const record = await readActiveWeeklyProposal(client, parsed.sellerId, parsed.weekStart);
      return weeklyRouteProposalMutationResponseSchema.parse({ schemaVersion: 1,
        outcome: 'existing', record });
    } catch (error) {
      if (!(error instanceof RouteRequestError && error.status === 404)) throw proposalConflict(error);
    }
    try {
      const record = await generateAndSaveWeeklyProposal(client, parsed, now);
      return weeklyRouteProposalMutationResponseSchema.parse({ schemaVersion: 1,
        outcome: 'created', record });
    } catch (error) {
      if (error instanceof RouteRequestError && error.status === 409
          && error.code === 'VERSION_CONFLICT') {
        const record = await readActiveWeeklyProposal(client, parsed.sellerId, parsed.weekStart);
        return weeklyRouteProposalMutationResponseSchema.parse({ schemaVersion: 1,
          outcome: 'existing', record });
      }
      throw proposalConflict(error);
    }
  }

  const proposal = await generateWeeklyProposal(client, {
    schemaVersion: parsed.schemaVersion,
    sellerId: parsed.sellerId,
    weekStart: parsed.weekStart,
    strategyPreference: parsed.strategyPreference,
  }, now);
  const persistenceCommand = regenerateWeeklyRouteProposalRequestSchema.parse({
    schemaVersion: 1, idempotencyKey: parsed.idempotencyKey,
    expectedVersion: parsed.expectedVersion, proposal,
  });
  try {
    const record = persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client,
      'regenerate_weekly_route_proposal', { p_id: parsed.proposalId, p_command: persistenceCommand }));
    return weeklyRouteProposalMutationResponseSchema.parse({ schemaVersion: 1,
      outcome: 'regenerated', record });
  } catch (error) {
    throw proposalConflict(error);
  }
}

export async function inspectWeeklyProposal(client: SupabaseClient, proposalId: string) {
  return persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client, 'get_weekly_route_proposal', {
    p_id: z.uuid().parse(proposalId),
  }));
}

export async function reviseWeeklyProposal(client: SupabaseClient, proposalId: string,
  command: ReviseWeeklyRouteProposalRequest) {
  return persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client, 'revise_weekly_route_proposal', {
    p_id: z.uuid().parse(proposalId), p_command: reviseWeeklyRouteProposalRequestSchema.parse(command),
  }));
}

export async function decideWeeklyProposal(client: SupabaseClient, proposalId: string,
  command: DecideWeeklyRouteProposalRequest) {
  return persistedWeeklyRouteProposalSchema.parse(await clientImportRpc(client, 'decide_weekly_route_proposal', {
    p_id: z.uuid().parse(proposalId), p_command: decideWeeklyRouteProposalRequestSchema.parse(command),
  }));
}

export async function captureDailySellerLocation(client: SupabaseClient, command: unknown) {
  return dailySellerLocationSchema.parse(await clientImportRpc(client, 'capture_daily_seller_location', {
    p_command: command,
  }));
}
