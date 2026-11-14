import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runFieldOutcomeCommand, type FieldOutcomeOperation } from './field-route-outcomes';

async function stdin() { let value=''; if (!process.stdin.isTTY) for await (const chunk of process.stdin) value+=chunk; return value.trim(); }
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    url: { type: 'string' }, 'app-url': { type: 'string' }, 'anon-key': { type: 'string' }, device: { type: 'string' }, key: { type: 'string' },
    file: { type: 'string' }, json: { type: 'boolean' },
  }});
  const operation = positionals[0] as FieldOutcomeOperation | undefined;
  if (!operation || !['catalog','classify','close','extend-route','reserve-evidence','confirm-evidence','record-attempt'].includes(operation))
    throw new Error('Use catalog|classify|close|extend-route|reserve-evidence|confirm-evidence|record-attempt.');
  const supabaseUrl=values.url ?? process.env.CIRNE_SUPABASE_URL?.trim();
  const anonKey=values['anon-key'] ?? process.env.CIRNE_SUPABASE_ANON_KEY?.trim();
  const token=process.env.CIRNE_SELLER_ACCESS_TOKEN?.trim() || await stdin();
  if (!supabaseUrl || !anonKey || !token) throw new Error('Informe URL, anon key e token do vendedor por stdin/CIRNE_SELLER_ACCESS_TOKEN.');
  const command=values.file ? JSON.parse(await readFile(values.file,'utf8')) as unknown : undefined;
  const result=await runFieldOutcomeCommand({ operation,supabaseUrl,appUrl:values['app-url']??process.env.CIRNE_APP_URL?.trim(),anonKey,token,deviceId:values.device,idempotencyKey:values.key,command });
  console.log(JSON.stringify(result,null,values.json ? 0 : 2));
} catch(error) { console.error(error instanceof Error ? error.message : 'Falha no comando de campo.'); process.exitCode=1; }
