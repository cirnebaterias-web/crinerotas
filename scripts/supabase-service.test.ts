import { describe, expect, it, vi } from 'vitest';
import { manageDatabase, validateNetwork } from './supabase-service';
import { bindingOption, networkLabel, networkName, projectId } from './local-settings';
import type { Run } from './process';

const network = [{ Driver: 'bridge', Options: { [bindingOption]: '127.0.0.1' }, Labels: { [networkLabel]: projectId } }];
function runtime() {
  return vi.fn<Run>().mockImplementation(async (_command, args) => {
    if (args[0] === 'context') return { ok: true, output: JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]) };
    if (args[0] === 'network' && args[1] === 'inspect') return { ok: true, output: JSON.stringify(network) };
    return { ok: true, output: '2.117.0' };
  });
}

describe('local database safety', () => {
  it('does not install or mutate when Docker is absent', async () => {
    const execute = vi.fn<Run>().mockResolvedValue({ ok: false, output: '' });
    await expect(manageDatabase('start', execute, {})).rejects.toThrow('Docker indisponível');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects remote contexts and unsafe existing networks', async () => {
    const execute = runtime();
    await expect(manageDatabase('start', execute, { DOCKER_HOST: 'tcp://remote:2375' })).rejects.toThrow('remoto');
    expect(execute).not.toHaveBeenCalled();
    expect(() => validateNetwork([{ ...network[0], Options: { [bindingOption]: '0.0.0.0' } }])).toThrow('incompatível');
    expect(() => validateNetwork([{ ...network[0], Labels: {} }])).toThrow('incompatível');
  });
  it('starts only on the dedicated network, stops only its project and keeps backups', async () => {
    const execute = runtime();
    await manageDatabase('start', execute, {});
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(['start', '--network-id', networkName]);
    await manageDatabase('stop', execute, {});
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(['stop', '--project-id', projectId]);
    expect(JSON.stringify(execute.mock.calls)).not.toContain('--no-backup');
  });
  it('never relays credential-bearing Supabase output on failure', async () => {
    const execute = runtime();
    execute.mockImplementationOnce(async () => ({ ok: true, output: JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]) }));
    execute.mockImplementationOnce(async () => ({ ok: true, output: '' }));
    execute.mockImplementationOnce(async () => ({ ok: true, output: '2.117.0' }));
    execute.mockImplementationOnce(async () => ({ ok: false, output: 'service_role=secret' }));
    await expect(manageDatabase('stop', execute, {})).rejects.toThrow('saída omitida');
  });
});
