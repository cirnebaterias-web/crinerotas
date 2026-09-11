import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectId } from './local-settings';
import { root, run, supabaseBinary } from './process';
import { provisionSyntheticActors } from './provision-synthetic-actors';
import { manageDatabase } from './supabase-service';

async function latestMigrationVersion() {
  const names = await readdir(path.join(root, 'supabase', 'migrations'));
  const versions = names
    .map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort();
  const latest = versions.at(-1);
  if (!latest) throw new Error('Nenhuma migração versionada foi encontrada.');
  return latest;
}

async function assertLatestMigrationApplied(expected: string) {
  const databaseContainer = `supabase_db_${projectId}`;
  const result = await run('docker', [
    'exec', databaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc',
    "select coalesce(max(version), '') from supabase_migrations.schema_migrations;",
  ]);
  if (!result.ok || result.output.trim() !== expected) {
    throw new Error('Reset local falhou antes de concluir as migrações; os atores não foram provisionados.');
  }
}

try {
  const expected = await latestMigrationVersion();
  const reset = await run(supabaseBinary, ['db', 'reset', '--local', '--no-seed'], 240_000);
  await assertLatestMigrationApplied(expected);

  // O reset recria o container do banco na rede padrão do CLI. O ciclo
  // controlado restaura a rede dedicada e os bindings somente em loopback.
  await manageDatabase('stop');
  await manageDatabase('start');
  await provisionSyntheticActors();

  console.log(reset.ok
    ? 'Base local recriada e atores sintéticos provisionados.'
    : 'Base local recriada; rede dedicada restaurada após health check transitório.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha ao recriar a base local.');
  process.exitCode = 1;
}
