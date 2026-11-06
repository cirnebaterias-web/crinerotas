import { createHash, randomUUID } from 'node:crypto';
import { readScrapLedgerSheetConfig, readScrapLedgerSyncServerConfig } from '@cirne/config/scrap-ledger-sync';
import { scrapLedgerRunSchema, scrapLedgerScheduledSlot, scrapLedgerSyncStatusSchema, type MeResponse } from '@cirne/contracts';
import { normalizeScrapBalanceRows, normalizeScrapLedgerRows, scrapBalanceTuple, scrapEntryTuple } from '@cirne/domain';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RouteRequestError } from '../routes/http';
import { createGoogleScrapLedgerReader } from '../../../../cli/src/scrap-ledger-google';

async function rpc(client:SupabaseClient,name:string,args:Record<string,unknown>={}){const{data,error}=await client.schema('api').rpc(name,args).abortSignal(AbortSignal.timeout(120_000));if(!error)return data as unknown;const known={AUTH_REQUIRED:401,FORBIDDEN:403,NOT_FOUND:404,VALIDATION_FAILED:422} as const;if(error.code==='P0001'&&error.message in known){const code=error.message as keyof typeof known;throw new RouteRequestError(known[code],code,code==='FORBIDDEN'?'Operação não autorizada.':'Não foi possível processar a conta-corrente de sucata.',false);}throw new RouteRequestError(503,'DEPENDENCY_UNAVAILABLE','Conta-corrente de sucata temporariamente indisponível.',true);}
const hash=(rows:readonly unknown[])=>{const h=createHash('sha256');for(const row of rows)h.update(JSON.stringify(row));return h.digest('hex');};
export async function getScrapLedgerSyncStatus(client:SupabaseClient,env:Record<string,string|undefined>=process.env){const config=readScrapLedgerSyncServerConfig(env);const raw=config.configured?await rpc(client,'get_scrap_ledger_sync_status'): {latestRun:null,lastSuccessAt:null};const db=(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{latestRun:null,lastSuccessAt:null}) as Record<string,unknown>;return scrapLedgerSyncStatusSchema.parse({...db,configured:config.configured,reason:config.reason,scheduleEnabled:config.configured&&config.config.scheduleEnabled,timeZone:'America/Sao_Paulo',times:['08:00','18:00']});}
export async function synchronizeScrapLedger(client:SupabaseClient,identity:MeResponse,command:{trigger:'manual';idempotencyKey:string}|{trigger:'scheduled'},origin:'web'|'cli',options:{env?:Record<string,string|undefined>;clock?:()=>Date}={}){
 const env=options.env??process.env;const state=readScrapLedgerSheetConfig(env);if(!state.configured)throw new RouteRequestError(503,'DEPENDENCY_UNAVAILABLE','A integração de sucata está desativada ou incompleta.',false);
 if(command.trigger==='scheduled'&&(origin!=='cli'||!state.config.scheduleEnabled||identity.id!==state.config.schedulerActorId))throw new RouteRequestError(403,'FORBIDDEN','Atualização agendada não autorizada.',false);
 const requestKey=command.trigger==='manual'?command.idempotencyKey:scrapLedgerScheduledSlot((options.clock??(()=>new Date()))());if(!requestKey)throw new RouteRequestError(422,'VALIDATION_FAILED','Atualização agendada permitida às 08:00 ou 18:00 em São Paulo.',false);
 const begun=scrapLedgerRunSchema.parse(await rpc(client,'begin_scrap_ledger_sync',{p_request_key:requestKey,p_trigger:command.trigger}));if(begun.status==='published')return begun;
 if(begun.status==='failed')throw new RouteRequestError(409,'VERSION_CONFLICT','Esta tentativa já falhou. Inicie uma nova atualização.',false);
 try{
  const read=await createGoogleScrapLedgerReader(state.config);const first=await read();const entries=normalizeScrapLedgerRows(first.entries);const balances=normalizeScrapBalanceRows(first.balances);const firstHash=hash([entries.map(scrapEntryTuple),balances.map(scrapBalanceTuple)]);const second=await read();const entries2=normalizeScrapLedgerRows(second.entries);const balances2=normalizeScrapBalanceRows(second.balances);const contentHash=hash([entries2.map(scrapEntryTuple),balances2.map(scrapBalanceTuple)]);if(firstHash!==contentHash)throw new RouteRequestError(409,'VERSION_CONFLICT','A planilha mudou durante a leitura. Tente novamente.',true);
  for(let index=0;index<entries2.length;index+=300)await rpc(client,'stage_scrap_ledger_entries',{p_run_id:begun.id,p_rows:entries2.slice(index,index+300)});
  for(let index=0;index<balances2.length;index+=300)await rpc(client,'stage_scrap_ledger_balances',{p_run_id:begun.id,p_rows:balances2.slice(index,index+300)});
  return scrapLedgerRunSchema.parse(await rpc(client,'publish_staged_scrap_ledger',{p_run_id:begun.id,p_content_hash:contentHash,p_entry_count:entries2.length,p_balance_count:balances2.length}));
 }catch(error){try{await rpc(client,'fail_scrap_ledger_sync',{p_run_id:begun.id,p_error_code:'SYNC_FAILED'});}catch{/* Preserve the acquisition/staging error. */}throw error;}
}
export async function getClientScrapSummary(client:SupabaseClient,clientId:string){return rpc(client,'get_client_scrap_summary',{p_client_id:clientId});}
export async function getScrapLedgerAnalytics(client:SupabaseClient,view:string,search:string,page:number){return rpc(client,'get_scrap_ledger_analytics',{p_view:view,p_search:search,p_page:page});}
export const newScrapManualCommand=()=>({trigger:'manual' as const,idempotencyKey:randomUUID()});
