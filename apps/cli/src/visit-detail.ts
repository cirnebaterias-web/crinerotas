import {
  apiErrorResponseSchema,
  visitDetailPath,
  visitDetailResponseSchema,
  type VisitDetailResponse,
} from '@cirne/contracts';
import { z } from 'zod';

export const visitDetailExitCodes = {
  success: 0,
  notFound: 66,
  invalidArgument: 64,
  dependencyFailure: 69,
  accessDenied: 77,
} as const;

export class VisitDetailCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function parseVisitId(value: string | undefined) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new VisitDetailCliError(visitDetailExitCodes.invalidArgument, 'Use --visit-id com um UUID canônico.');
  }
  return parsed.data;
}

export async function loadVisitDetail(
  baseUrl: string,
  token: string,
  visitId: string,
  request: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await request(new URL(visitDetailPath(visitId), baseUrl), {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
    });
  } catch {
    throw new VisitDetailCliError(visitDetailExitCodes.dependencyFailure, 'Serviço de visitas indisponível.');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    const message = parsed.success ? parsed.data.error.message : 'Serviço de visitas indisponível.';
    const exitCode = response.status === 404 ? visitDetailExitCodes.notFound
      : response.status === 401 || response.status === 403 ? visitDetailExitCodes.accessDenied
        : response.status === 400 || response.status === 422 ? visitDetailExitCodes.invalidArgument
          : visitDetailExitCodes.dependencyFailure;
    throw new VisitDetailCliError(exitCode, message);
  }
  const parsed = visitDetailResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.visitId !== visitId) {
    throw new VisitDetailCliError(visitDetailExitCodes.dependencyFailure, 'Resposta de detalhe inválida.');
  }
  return parsed.data;
}

function sectionLabel(section: { state: string }) {
  return section.state === 'available' ? 'disponível'
    : section.state === 'absent' ? 'não informado'
      : section.state === 'withheld' ? 'oculto por permissão' : 'não conhecido pelo servidor';
}

export function formatVisitDetail(detail: VisitDetailResponse) {
  const lines = [
    `Visita ${detail.visitId}`,
    `${detail.context.client.name} · ${detail.context.seller.displayName} · ${detail.context.serviceDate}`,
    `Situação: ${detail.status === 'completed' ? 'concluída' : 'em andamento'}`,
    `Estoque: ${sectionLabel(detail.sections.stock)}`,
    `Preços da concorrência: ${sectionLabel(detail.sections.competitorPrices)}`,
    `Ações comerciais: ${sectionLabel(detail.sections.commercialActions)}`,
    `Sucata: ${sectionLabel(detail.sections.scrap)}`,
    `Localização: ${sectionLabel(detail.location)}`,
    `Evidências: ${sectionLabel(detail.evidence)}`,
    `Sincronização: ${detail.synchronization.status} · ${detail.synchronization.attemptCount} tentativa(s)`,
    detail.serverVisibilityNote,
  ];
  return lines.join('\n');
}

export async function runVisitDetailCommand(options: {
  baseUrl: string;
  token: string;
  visitId?: string;
  json: boolean;
  request?: typeof fetch;
}) {
  const visitId = parseVisitId(options.visitId);
  const detail = await loadVisitDetail(options.baseUrl, options.token, visitId, options.request);
  return { exitCode: visitDetailExitCodes.success, output: options.json ? JSON.stringify(detail) : formatVisitDetail(detail) };
}
