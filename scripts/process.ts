import { execFile } from 'node:child_process';
import path from 'node:path';

export type CommandResult = { ok: boolean; output: string };
export type Run = (command: string, args: string[], timeout?: number) => Promise<CommandResult>;
export const root = path.resolve(import.meta.dirname, '..');
export const supabaseBinary = path.join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');

export const run: Run = (command, args, timeout = 30000) => new Promise((resolve) => {
  // Execute the installed Node shim without a shell (including on Windows).
  const executable = command === supabaseBinary ? process.execPath : command;
  const commandArgs = command === supabaseBinary ? [supabaseBinary, ...args] : args;
  execFile(executable, commandArgs, { cwd: root, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
    const output = stdout.toString(stdout.includes(0) ? 'utf16le' : 'utf8').replace(/\u0000/g, '');
    resolve({ ok: !error, output });
  });
});
