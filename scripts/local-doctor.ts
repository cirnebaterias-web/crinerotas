import { parseArgs } from 'node:util';
import { diagnose } from './doctor';

try {
  const { values } = parseArgs({ options: { json: { type: 'boolean' } }, strict: true });
  const checks = await diagnose();
  const ok = checks.every((check) => check.ok);
  console.log(values.json ? JSON.stringify({ ok, checks }) : checks.map((check) => `${check.ok ? 'OK' : 'FALTA'} ${check.name}: ${check.detail}`).join('\n'));
  process.exitCode = ok ? 0 : 1;
} catch {
  console.error(JSON.stringify({ ok: false, message: 'Diagnóstico inválido. Confira --json, CIRNE_WEB_PORT e supabase/config.toml.' }));
  process.exitCode = 1;
}
