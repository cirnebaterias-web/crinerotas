import { parseArgs } from 'node:util';
import { verifyBackupManifest } from './backup-verify';

try {
  const { values } = parseArgs({
    options: { manifest: { type: 'string' } },
    strict: true,
  });
  const result = await verifyBackupManifest(values.manifest ?? '');
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  // Never print raw filesystem errors, manifest contents, object paths or credentials.
  const detail = error instanceof Error && /^(Informe|Formato|Campos|Versão|Marco|Caminho|Metadados|Cobertura|Mapeamento|Arquivo|Link simbólico|Tamanho|SHA-256|JSON|Total)/.test(error.message)
    ? error.message : 'Não foi possível verificar o backup.';
  console.error(JSON.stringify({ ok: false, message: detail }));
  process.exitCode = 1;
}
