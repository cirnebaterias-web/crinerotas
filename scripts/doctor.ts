import { createServer } from 'node:net';
import { configuredPorts } from './local-settings';
import { run, supabaseBinary, type Run } from './process';

export type Check = { name: string; ok: boolean; detail: string };
export function supportedVersion(version: string | undefined, major: number, minor: number, patch = 0) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split('.').map(Number);
  return parts[0] === major && (parts[1]! > minor || (parts[1] === minor && parts[2]! >= patch));
}
export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function diagnose(execute: Run = run, ports = configuredPorts(), platform: NodeJS.Platform = process.platform, probe = portAvailable): Promise<Check[]> {
  const checks: Check[] = [];
  async function tool(name: string, command: string, args: string[], required: (version: string | undefined) => boolean, hint: string) {
    const result = await execute(command, args);
    const version = result.output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/)?.[0];
    const ok = result.ok && required(version);
    checks.push({ name, ok, detail: ok ? version! : hint });
  }
  await tool('node', process.execPath, ['--version'], (v) => supportedVersion(v, 24, 19), 'Requer Node 24.19.0 ou superior da linha 24.');
  if (process.env.npm_execpath) await tool('npm', process.execPath, [process.env.npm_execpath, '--version'], (v) => supportedVersion(v, 11, 17), 'Requer npm 11.17.0 ou superior da linha 11.');
  else checks.push({ name: 'npm', ok: false, detail: 'Execute pelo script npm run local:doctor.' });
  if (platform === 'win32') {
    const wsl = await execute('wsl.exe', ['--list', '--verbose']);
    const hasWsl2 = wsl.ok && /\s2\s*$/m.test(wsl.output);
    checks.push({ name: 'wsl2', ok: hasWsl2, detail: hasWsl2 ? 'Distribuição WSL2 disponível.' : 'Requer distribuição WSL2; confira wsl --list --verbose.' });
  } else checks.push({ name: 'wsl2', ok: true, detail: 'Não aplicável fora do Windows.' });
  await tool('docker', 'docker', ['version', '--format', '{{.Server.Version}}'], (v) => !!v, 'Instale/inicie um runtime Docker compatível (Rancher Desktop, dockerd).');
  await tool('compose', 'docker', ['compose', 'version', '--short'], (v) => !!v && Number(v.split('.')[0]) >= 2, 'Disponibilize Docker Compose v2 ou superior.');
  await tool('supabase', supabaseBinary, ['--version'], (v) => v === '2.117.0', 'Execute npm ci para instalar Supabase CLI 2.117.0.');
  for (const port of ports) checks.push({ name: `port:${port}`, ok: await probe(port), detail: 'Loopback; porta ocupada também pode indicar serviço já iniciado. Não encerre processos desconhecidos.' });
  return checks;
}
