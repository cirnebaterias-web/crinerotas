import {
  classifyClientCommandSchema, classifyClientResultSchema, clientClassificationCatalogSchema,
  closeClientCommandSchema, closeClientResultSchema, extendSellerRouteCommandSchema,
  extendSellerRouteResultSchema, recordRouteStopAttemptCommandSchema, recordRouteStopAttemptResultSchema,
  reserveRouteStopAttemptAttachmentCommandSchema,
  routeStopAttemptAttachmentIntentResultSchema, routeStopAttemptAttachmentConfirmationSchema,
  routeStopAttemptAttachmentPath, routeStopAttemptAttachmentConfirmPath,
} from '@cirne/contracts';
import { z } from 'zod';

type Requester = typeof fetch;
const uuid = z.uuid();

async function rpc(request: Requester, url: string, anonKey: string, token: string, name: string, body: unknown) {
  const response = await request(new URL(`/rest/v1/rpc/${name}`, url), {
    method: 'POST', cache: 'no-store',
    headers: { apikey: anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json() as unknown;
  if (!response.ok) throw new Error(`RPC ${name} respondeu HTTP ${response.status}.`);
  return result;
}

export type FieldOutcomeOperation = 'catalog' | 'classify' | 'close' | 'extend-route' | 'reserve-evidence' | 'confirm-evidence' | 'record-attempt';
export async function runFieldOutcomeCommand(options: {
  operation: FieldOutcomeOperation; supabaseUrl: string; anonKey: string; token: string;
  appUrl?: string; deviceId?: string; idempotencyKey?: string; command?: unknown; request?: Requester;
}) {
  const request = options.request ?? fetch;
  if (options.operation === 'catalog') {
    return clientClassificationCatalogSchema.parse(await rpc(request, options.supabaseUrl, options.anonKey, options.token,
      'list_client_classifications', {}));
  }
  const deviceId = uuid.parse(options.deviceId);
  const idempotencyKey = uuid.parse(options.idempotencyKey);
  if (options.operation === 'classify') return classifyClientResultSchema.parse(await rpc(request, options.supabaseUrl, options.anonKey,
    options.token, 'classify_client', { p_device_id: deviceId, p_idempotency_key: idempotencyKey,
      p_command: classifyClientCommandSchema.parse(options.command) }));
  if (options.operation === 'close') return closeClientResultSchema.parse(await rpc(request, options.supabaseUrl, options.anonKey,
    options.token, 'close_client_operations', { p_device_id: deviceId, p_idempotency_key: idempotencyKey,
      p_command: closeClientCommandSchema.parse(options.command) }));
  if (options.operation === 'extend-route') return extendSellerRouteResultSchema.parse(await rpc(request, options.supabaseUrl, options.anonKey,
    options.token, 'extend_seller_route', { p_device_id: deviceId, p_idempotency_key: idempotencyKey,
      p_command: extendSellerRouteCommandSchema.parse(options.command) }));
  if (options.operation === 'reserve-evidence') {
    if (!options.appUrl) throw new Error('Informe --app-url para reservar e verificar evidências pelo BFF confiável.');
    const response=await request(new URL(routeStopAttemptAttachmentPath,options.appUrl),{method:'POST',headers:{authorization:`Bearer ${options.token}`,
      'content-type':'application/json','x-device-id':deviceId,'idempotency-key':idempotencyKey},body:JSON.stringify(reserveRouteStopAttemptAttachmentCommandSchema.parse(options.command))});
    if(!response.ok)throw new Error(`BFF de evidência respondeu HTTP ${response.status}.`);
    return routeStopAttemptAttachmentIntentResultSchema.parse(await response.json());
  }
  if (options.operation === 'confirm-evidence') {
    const command = z.object({ offlineId: uuid, checksum: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(options.command);
    if (!options.appUrl) throw new Error('Informe --app-url para verificar evidências pelo BFF confiável.');
    const response=await request(new URL(routeStopAttemptAttachmentConfirmPath(command.offlineId),options.appUrl),{method:'POST',headers:{authorization:`Bearer ${options.token}`,
      'content-type':'application/json','x-device-id':deviceId,'idempotency-key':idempotencyKey},body:JSON.stringify({schemaVersion:1,checksum:command.checksum})});
    if(!response.ok)throw new Error(`BFF de evidência respondeu HTTP ${response.status}.`);
    return routeStopAttemptAttachmentConfirmationSchema.parse(await response.json());
  }
  return recordRouteStopAttemptResultSchema.parse(await rpc(request, options.supabaseUrl, options.anonKey, options.token,
    'record_route_stop_attempt', { p_device_id: deviceId, p_idempotency_key: idempotencyKey,
      p_command: recordRouteStopAttemptCommandSchema.parse(options.command) }));
}
