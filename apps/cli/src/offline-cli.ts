import { parseArgs } from 'node:util';
import { offlinePartitionSchema } from '@cirne/contracts';
import { inspectOfflineFoundation } from './offline';

const defaults = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};

const json = process.argv.includes('--json');
try {
  const { values } = parseArgs({
    options: {
      user: { type: 'string', default: defaults.userId },
      device: { type: 'string', default: defaults.deviceId },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const result = inspectOfflineFoundation(offlinePartitionSchema.parse({
    userId: values.user,
    deviceId: values.device,
  }));
  console.log(json ? JSON.stringify(result) : `OK: snapshot canônico offline v${result.schemaVersion}; ${result.stopCount} parada sintética; sincronização habilitada.`);
} catch {
  console.error(json ? JSON.stringify({ status: 'error', message: 'Partição offline inválida.' }) : 'Partição offline inválida. Use UUIDs em --user e --device.');
  process.exitCode = 1;
}
