import { randomUUID } from 'node:crypto';
import { loginSheetSyncOperator, safeSyncOrigin } from './client-sheet-sync';
import { scrapLedgerSyncPath } from '@cirne/contracts';

async function main(){const env=process.env;const base=env.CIRNE_BASE_URL;if(!base)throw new Error('Defina CIRNE_BASE_URL.');const scheduled=process.argv.includes('--scheduled');const token=await loginSheetSyncOperator({...env,CIRNE_SHEET_SYNC_EMAIL:env.CIRNE_SCRAP_SYNC_EMAIL,CIRNE_SHEET_SYNC_PASSWORD:env.CIRNE_SCRAP_SYNC_PASSWORD});const response=await fetch(new URL(scrapLedgerSyncPath,safeSyncOrigin(base)),{method:'POST',redirect:'error',signal:AbortSignal.timeout(180_000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(scheduled?{trigger:'scheduled'}:{trigger:'manual',idempotencyKey:randomUUID()})});const body=await response.text();if(!response.ok)throw new Error(`Atualização de sucata falhou (${response.status}): ${body.slice(0,500)}`);process.stdout.write(`${body}\n`);}
main().catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:'Falha inesperada.'}\n`);process.exitCode=1;});
