import {
  apiErrorResponseSchema, logisticsOperatorsPath, logisticsOperatorListSchema,
  logisticsPickupsPath, logisticsPickupListSchema, logisticsPickupRecordSchema,
  type LogisticsPickupAction,
} from '@cirne/contracts';

async function request(path: string, options?: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000), ...options }); }
  catch { throw new Error('A conexão não respondeu. Seus dados continuam no formulário; tente novamente para confirmar o registro.'); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(body);
    if (response.status === 401) throw new Error('Sua sessão expirou. Entre novamente para continuar.');
    if (response.status === 403) throw new Error('Seu perfil não tem permissão para esta operação.');
    if (response.status === 409) throw new Error('A parada mudou ou esta ordem já está ocupada. Atualize a rota e confira os dados antes de tentar novamente.');
    if (response.status === 422 && parsed.success) throw new Error(parsed.data.error.message);
    throw new Error('Não foi possível confirmar a operação. Confira a conexão e tente novamente.');
  }
  return body;
}

function readResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Não foi possível interpretar a resposta das coletas. Atualize a página e tente novamente.');
  return parsed.data;
}

export const logisticsPickupsClient = {
  async list(date: string) {
    return readResponse(logisticsPickupListSchema, await request(`${logisticsPickupsPath}?date=${encodeURIComponent(date)}`));
  },
  async operators() { return readResponse(logisticsOperatorListSchema, await request(logisticsOperatorsPath)); },
  async mutate(scheduleId: string, action: LogisticsPickupAction, body: unknown, key: string) {
    return readResponse(logisticsPickupRecordSchema, await request(`${logisticsPickupsPath}/${encodeURIComponent(scheduleId)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1', 'idempotency-key': key },
      body: JSON.stringify(body),
    }));
  },
};
