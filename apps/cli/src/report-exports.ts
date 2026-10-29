import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  apiErrorResponseSchema,
  reportExportQuerySchema,
  reportExportsPath,
  type ReportExportQuery,
} from '@cirne/contracts';

export const reportExportExitCodes = {
  success: 0, invalidArgument: 64, dependencyFailure: 69, cannotCreate: 73, accessDenied: 77,
} as const;

export class ReportExportCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}

export function resolveReportExportQuery(values: Record<string, string | undefined>) {
  const parsed = reportExportQuerySchema.safeParse(Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ));
  if (!parsed.success) {
    throw new ReportExportCliError(
      reportExportExitCodes.invalidArgument,
      parsed.error.issues[0]?.message ?? 'Filtros de exportação inválidos.',
    );
  }
  return parsed.data;
}

function validPayload(query: ReportExportQuery, bytes: Uint8Array) {
  if (query.format === 'csv') return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function downloadReportExport(options: {
  baseUrl: string;
  token: string;
  query: ReportExportQuery;
  outputPath: string;
  request?: typeof fetch;
  write?: typeof writeFile;
}) {
  const extension = extname(options.outputPath).toLowerCase();
  if (extension !== `.${options.query.format}`) {
    throw new ReportExportCliError(
      reportExportExitCodes.invalidArgument, `O caminho de saída deve terminar em .${options.query.format}.`,
    );
  }
  const url = new URL(reportExportsPath, options.baseUrl);
  for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await (options.request ?? fetch)(url, {
      headers: { authorization: `Bearer ${options.token}` }, cache: 'no-store', signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ReportExportCliError(reportExportExitCodes.dependencyFailure, 'Serviço de exportação indisponível.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as unknown;
    const failure = apiErrorResponseSchema.safeParse(body);
    const exitCode = response.status === 401 || response.status === 403
      ? reportExportExitCodes.accessDenied
      : response.status === 400 || response.status === 422
        ? reportExportExitCodes.invalidArgument : reportExportExitCodes.dependencyFailure;
    throw new ReportExportCliError(
      exitCode, failure.success ? failure.data.error.message : 'Não foi possível gerar o relatório.',
    );
  }
  const expectedType = options.query.format === 'csv'
    ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const disposition = response.headers.get('content-disposition') ?? '';
  const dispositionMatch = /^attachment; filename="cirne-[a-z0-9-]+\.(csv|xlsx)"$/u.exec(disposition);
  const rowCount = response.headers.get('x-export-row-count') ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!contentType.startsWith(expectedType) || dispositionMatch?.[1] !== options.query.format ||
      !/^\d{1,5}$/u.test(rowCount) || Number(rowCount) > 10_000 || !validPayload(options.query, bytes)) {
    throw new ReportExportCliError(reportExportExitCodes.dependencyFailure, 'O servidor retornou um arquivo de relatório inválido.');
  }
  const outputPath = resolve(options.outputPath);
  try {
    await (options.write ?? writeFile)(outputPath, bytes, { flag: 'wx' });
  } catch {
    throw new ReportExportCliError(
      reportExportExitCodes.cannotCreate, 'Não foi possível criar o arquivo; escolha um caminho novo e gravável.',
    );
  }
  return { outputPath, rowCount: Number(rowCount), bytes: bytes.byteLength };
}
