import { assertProjectIdentity, bindingOption, networkLabel, networkName, projectId } from './local-settings';
import { run, supabaseBinary, type Run } from './process';

export function validateNetwork(value: unknown) {
  const networks = value as { Driver?: string; Options?: Record<string, string>; Labels?: Record<string, string> }[];
  if (!Array.isArray(networks) || networks.length !== 1 || networks[0]?.Driver !== 'bridge' ||
    networks[0]?.Options?.[bindingOption] !== '127.0.0.1' || networks[0]?.Labels?.[networkLabel] !== projectId) {
    throw new Error('Rede existente incompatível. Nada foi alterado; revise o isolamento da rede Cirne.');
  }
}

export async function manageDatabase(action: string, execute: Run = run, env = process.env) {
  if (!['start', 'stop'].includes(action)) throw new Error('Use db:start ou db:stop.');
  assertProjectIdentity();
  if (env.DOCKER_HOST && !/^(unix:\/\/|npipe:\/\/)/.test(env.DOCKER_HOST)) throw new Error('DOCKER_HOST remoto não é permitido neste fluxo local.');
  const context = await execute('docker', ['context', 'inspect']);
  if (!context.ok) throw new Error('Docker indisponível. Execute npm run local:doctor.');
  let host: unknown;
  try { host = JSON.parse(context.output)[0]?.Endpoints?.docker?.Host; } catch { /* fail closed */ }
  if (typeof host !== 'string' || !/^(unix:\/\/|npipe:\/\/)/.test(host)) throw new Error('Contexto Docker não é local; nenhuma ação realizada.');
  if (!(await execute('docker', ['info', '--format', '{{.ServerVersion}}'])).ok) throw new Error('Runtime Docker não está iniciado.');
  if (!(await execute(supabaseBinary, ['--version'])).ok) throw new Error('Supabase CLI ausente. Execute npm ci.');
  if (action === 'start') {
    const existing = await execute('docker', ['network', 'inspect', networkName]);
    if (existing.ok) {
      let network: unknown;
      try { network = JSON.parse(existing.output); } catch { throw new Error('Resposta de rede inválida.'); }
      validateNetwork(network);
    } else {
      const created = await execute('docker', ['network', 'create', '--driver', 'bridge', '--label', `${networkLabel}=${projectId}`, '--opt', `${bindingOption}=127.0.0.1`, networkName]);
      if (!created.ok) throw new Error('Não foi possível criar a rede local isolada.');
    }
  }
  const args = action === 'start' ? ['start', '--network-id', networkName] : ['stop', '--project-id', projectId];
  // Supabase prints generated credentials; do not relay its output to logs.
  if (!(await execute(supabaseBinary, args, 600000)).ok) throw new Error('Operação Supabase falhou. Verifique runtime/portas; saída omitida para proteger credenciais. Dados não foram removidos pelo script.');
  return action === 'start' ? 'Supabase local iniciado. Use somente dados sintéticos.' : 'Supabase local parado; volumes e rede preservados.';
}
