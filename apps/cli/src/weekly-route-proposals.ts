import { apiErrorResponseSchema, decideWeeklyRouteProposalRequestSchema, persistedWeeklyRouteProposalSchema,
  reviseWeeklyRouteProposalRequestSchema, weeklyRouteBaseCityOriginSchema, weeklyRouteCandidateSchema,
  weeklyRouteProposalMutationRequestSchema, weeklyRouteProposalMutationResponseSchema,
  weeklyRouteProposalSchema, weeklyRouteStrategyPreferenceSchema } from '@cirne/contracts';
import { proposeWeeklyRoutes } from '@cirne/domain';
import { z } from 'zod';
import { safeSyncOrigin } from './client-sheet-sync';

const inputSchema = z.object({
  weekStart: z.iso.date(), generatedAt: z.iso.datetime({ offset: true }),
  origin: weeklyRouteBaseCityOriginSchema, candidates: z.array(weeklyRouteCandidateSchema).max(5000),
  strategyPreference: weeklyRouteStrategyPreferenceSchema.optional(),
}).strict();

export function generateWeeklyRouteProposal(input: unknown) {
  const parsed = inputSchema.parse(input);
  return weeklyRouteProposalSchema.parse(proposeWeeklyRoutes(parsed));
}

export function weeklyRouteProposalSummary(input: unknown) {
  const proposal = generateWeeklyRouteProposal(input);
  return {
    status: 'ok' as const, mode: proposal.mode, policyVersion: proposal.policy.version,
    inactiveAfterDays: proposal.policy.inactiveAfterDays,
    sellerId: proposal.sellerId, weekStart: proposal.weekStart,
    strategy: proposal.strategy,
    counts: proposal.counts,
    days: proposal.days.map(({ serviceDate, suggestions }) => ({ serviceDate, clientCount: suggestions.length,
      coverageDue: suggestions.filter(({ coverageState }) =>
        coverageState === 'never_visited' || coverageState === 'overdue' || coverageState === 'due_this_week').length })),
  };
}

export class WeeklyRouteProposalCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

async function call(baseUrl: string, token: string, path: string, init: RequestInit,
  transport: typeof fetch) {
  const origin = safeSyncOrigin(baseUrl);
  let response: Response;
  try {
    response = await transport(new URL(path, origin), { ...init, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  } catch { throw new WeeklyRouteProposalCliError(69, 'Propostas semanais temporariamente indisponíveis.'); }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    throw new WeeklyRouteProposalCliError(response.status === 403 ? 77 : response.status === 409 ? 78
      : response.status === 422 ? 64 : 69, parsed.success ? parsed.data.error.message : 'Falha na proposta semanal.');
  }
  return body;
}

export async function saveWeeklyRouteProposal(baseUrl: string, token: string, command: unknown,
  transport: typeof fetch = fetch) {
  const parsed = weeklyRouteProposalMutationRequestSchema.parse(command);
  return weeklyRouteProposalMutationResponseSchema.parse(await call(baseUrl, token,
    '/api/v1/management/weekly-route-proposals', { method: 'POST', body: JSON.stringify(parsed) }, transport));
}

export async function inspectPersistedWeeklyRouteProposal(baseUrl: string, token: string, proposalId: string,
  transport: typeof fetch = fetch) {
  return persistedWeeklyRouteProposalSchema.parse(await call(baseUrl, token,
    `/api/v1/management/weekly-route-proposals/${z.uuid().parse(proposalId)}`, {}, transport));
}

export async function revisePersistedWeeklyRouteProposal(baseUrl: string, token: string, proposalId: string,
  command: unknown, transport: typeof fetch = fetch) {
  const parsed = reviseWeeklyRouteProposalRequestSchema.parse(command);
  return persistedWeeklyRouteProposalSchema.parse(await call(baseUrl, token,
    `/api/v1/management/weekly-route-proposals/${z.uuid().parse(proposalId)}`,
    { method: 'PATCH', body: JSON.stringify(parsed) }, transport));
}

export async function decidePersistedWeeklyRouteProposal(baseUrl: string, token: string, proposalId: string,
  command: unknown, transport: typeof fetch = fetch) {
  const parsed = decideWeeklyRouteProposalRequestSchema.parse(command);
  return persistedWeeklyRouteProposalSchema.parse(await call(baseUrl, token,
    `/api/v1/management/weekly-route-proposals/${z.uuid().parse(proposalId)}`,
    { method: 'PATCH', body: JSON.stringify(parsed) }, transport));
}
