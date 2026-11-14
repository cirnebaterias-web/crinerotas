import type { SupabaseClient } from '@supabase/supabase-js';
import {
  classifyClientResultSchema, clientClassificationCatalogSchema, clientFieldProfileSchema,
  closeClientResultSchema, extendSellerRouteResultSchema, recordRouteStopAttemptResultSchema,
  sellerRouteClientSearchResponseSchema,
  type ClassifyClientCommand, type CloseClientCommand, type ExtendSellerRouteCommand,
  type RecordRouteStopAttemptCommand,
} from '@cirne/contracts';
import { RouteRequestError } from '@/server/routes/http';

const statusByCode: Record<string, 400 | 401 | 403 | 404 | 409 | 422 | 503> = {
  AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409, CLIENT_ALREADY_ON_ROUTE: 409, ROUTE_STOP_LIMIT: 409,
  EVIDENCE_REQUIRED: 422, VALIDATION_FAILED: 422,
};

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.schema('api').rpc(name, args).abortSignal(AbortSignal.timeout(30_000));
  if (!error) return data as unknown;
  const code = error.code === 'P0001' ? error.message : 'DEPENDENCY_UNAVAILABLE';
  const status = statusByCode[code] ?? 503;
  const message = code === 'CLIENT_ALREADY_ON_ROUTE' ? 'Este cliente já está na rota.'
    : code === 'ROUTE_STOP_LIMIT' ? 'A rota atingiu o limite de paradas.'
      : code === 'VERSION_CONFLICT' ? 'Os dados mudaram no servidor. Atualize e tente novamente.'
        : code === 'EVIDENCE_REQUIRED' ? 'Confirme a foto da fachada antes de registrar.'
          : code === 'NOT_FOUND' ? 'Registro não encontrado ou fora da sua carteira.'
            : code === 'FORBIDDEN' ? 'Operação não autorizada.'
              : code === 'VALIDATION_FAILED' ? 'Revise os dados informados.'
                : 'Serviço temporariamente indisponível.';
  throw new RouteRequestError(status, status === 503 ? 'DEPENDENCY_UNAVAILABLE' :
    code === 'CLIENT_ALREADY_ON_ROUTE' || code === 'ROUTE_STOP_LIMIT' ? 'VERSION_CONFLICT' : code as never,
  message, status === 503);
}

export const listClassifications = async (client: SupabaseClient) =>
  clientClassificationCatalogSchema.parse(await rpc(client, 'list_client_classifications'));
export const getClientFieldProfile = async (client: SupabaseClient, clientId: string) =>
  clientFieldProfileSchema.parse(await rpc(client, 'get_client_field_profile', { p_client_id: clientId }));
export const searchRouteClients = async (client: SupabaseClient, routeId: string, query: string) =>
  sellerRouteClientSearchResponseSchema.parse(await rpc(client, 'search_my_route_clients', { p_route_id: routeId, p_query: query }));
export const classifyClient = async (client: SupabaseClient, deviceId: string, key: string, command: ClassifyClientCommand) =>
  classifyClientResultSchema.parse(await rpc(client, 'classify_client', { p_device_id: deviceId, p_idempotency_key: key, p_command: command }));
export const closeClient = async (client: SupabaseClient, deviceId: string, key: string, command: CloseClientCommand) =>
  closeClientResultSchema.parse(await rpc(client, 'close_client_operations', { p_device_id: deviceId, p_idempotency_key: key, p_command: command }));
export const extendRoute = async (client: SupabaseClient, deviceId: string, key: string, command: ExtendSellerRouteCommand) =>
  extendSellerRouteResultSchema.parse(await rpc(client, 'extend_seller_route', { p_device_id: deviceId, p_idempotency_key: key, p_command: command }));
export const recordStopAttempt = async (client: SupabaseClient, deviceId: string, key: string, command: RecordRouteStopAttemptCommand) =>
  recordRouteStopAttemptResultSchema.parse(await rpc(client, 'record_route_stop_attempt', { p_device_id: deviceId, p_idempotency_key: key, p_command: command }));
export { rpc as fieldOutcomeRpc };
