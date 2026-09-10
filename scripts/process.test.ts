import { expect, it } from 'vitest';
import { run, supabaseBinary } from './process';

it('executes the installed Supabase shim without shell interpolation', async () => {
  const result = await run(supabaseBinary, ['--version']);
  expect(result.ok).toBe(true);
  expect(result.output.trim()).toBe('2.117.0');
}, 40000);

it('returns a controlled result for a missing executable', async () => {
  expect(await run('cirne-nonexistent-executable-test', [])).toEqual({ ok: false, output: '' });
});
