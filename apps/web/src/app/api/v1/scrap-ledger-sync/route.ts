import { z } from 'zod';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { parseBearer } from '@/server/identity';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
import { getScrapLedgerSyncStatus, synchronizeScrapLedger } from '@/server/scrap-ledger-sync/service';
export const runtime='nodejs';export const dynamic='force-dynamic';
const command=z.discriminatedUnion('trigger',[z.object({trigger:z.literal('manual'),idempotencyKey:z.uuid()}),z.object({trigger:z.literal('scheduled')})]);
const requireSync=(identity:{capabilities:string[]})=>{if(!identity.capabilities.includes('scrap_ledger.sync'))throw new RouteRequestError(403,'FORBIDDEN','Operação não autorizada.',false);};
export function GET(request:Request){return handleClientImportRequest(request,'/api/v1/scrap-ledger-sync',async({identity,client},headers)=>{requireSync(identity);return Response.json(await getScrapLedgerSyncStatus(client),{headers});});}
export function POST(request:Request){return handleClientImportRequest(request,'/api/v1/scrap-ledger-sync',async({identity,client},headers)=>{requireSync(identity);const parsed=command.safeParse(await readRouteJson(request));if(!parsed.success)throw new RouteRequestError(422,'VALIDATION_FAILED','Comando inválido.',false);return Response.json(await synchronizeScrapLedger(client,identity,parsed.data,parseBearer(request.headers.get('authorization'))?'cli':'web'),{headers});});}
