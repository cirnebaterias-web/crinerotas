import { manageDatabase } from './supabase-service';

try {
  console.log(await manageDatabase(process.argv[2] ?? ''));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha na operação local.');
  process.exitCode = 1;
}
