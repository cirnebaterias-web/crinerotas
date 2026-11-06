import { z } from 'zod';
import {
  apiErrorResponseSchema, logisticsPickupDateSchema, logisticsPickupsPath, logisticsOperatorsPath,
  logisticsPickupListSchema, logisticsPickupRecordSchema, logisticsOperatorListSchema,
  assignLogisticsPickupSchema, recordLogisticsPickupSchema, correctLogisticsPickupSchema,
  reviewLogisticsPickupSchema, type LogisticsPickupAction,
} from '@cirne/contracts';

export class LogisticsPickupCliError extends Error {
  constructor(public readonly exitCode: number, message: string) { super(message); }
}
export type LogisticsPickupCommand = 'list' | 'operators' | LogisticsPickupAction;
function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LogisticsPickupCliError(64, 'Argumentos da operação de logística inválidos.');
  return parsed.data;
}

export async function runLogisticsPickupCommand(options: {
  baseUrl: string; token: string; operation: LogisticsPickupCommand;
  date?: string; scheduleId?: string; idempotencyKey?: string; body?: unknown; request?: typeof fetch;
}) {
  const mutation = options.operation !== 'list' && options.operation !== 'operators';
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  const url = new URL(options.operation === 'operators' ? logisticsOperatorsPath : logisticsPickupsPath, options.baseUrl);
  let body: unknown;
  if (mutation) {
    const id = parse(z.uuid(), options.scheduleId);
    const key = parse(z.uuid(), options.idempotencyKey);
    url.pathname += `/${id}/${options.operation}`;
    body = options.operation === 'assignment' ? parse(assignLogisticsPickupSchema, options.body)
      : options.operation === 'result' ? parse(recordLogisticsPickupSchema, options.body)
        : options.operation === 'correction' ? parse(correctLogisticsPickupSchema, options.body)
          : parse(reviewLogisticsPickupSchema, options.body);
    headers['idempotency-key'] = key;
    headers['content-type'] = 'application/json';
  } else if (options.operation === 'list') {
    url.searchParams.set('date', parse(logisticsPickupDateSchema, options.date));
  }
  let response: Response;
  let data: unknown;
  try {
    response = await (options.request ?? fetch)(url, { method: mutation ? 'POST' : 'GET', headers,
      body: mutation ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    data = await response.json();
  } catch { throw new LogisticsPickupCliError(69, 'Logística temporariamente indisponível; preserve a chave ao tentar novamente.'); }
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(data);
    const code = response.status === 401 || response.status === 403 ? 77 : response.status === 409 ? 75 : response.status === 422 ? 64 : 69;
    throw new LogisticsPickupCliError(code, error.success ? error.data.error.message : 'A operação de logística falhou.');
  }
  const schema = options.operation === 'operators' ? logisticsOperatorListSchema
    : options.operation === 'list' ? logisticsPickupListSchema : logisticsPickupRecordSchema;
  const result = schema.safeParse(data);
  if (!result.success) throw new LogisticsPickupCliError(69, 'Resposta de logística inválida.');
  return result.data;
}
