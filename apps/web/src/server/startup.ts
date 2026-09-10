import { readServerConfig } from '@cirne/config/server';

export function validateStartup() {
  try {
    readServerConfig(process.env);
  } catch (error) {
    // Next may keep listening after a rejected hook: terminate invalid startup.
    console.error(JSON.stringify({ level: 'fatal', event: 'invalid_configuration', message: error instanceof Error ? error.message : 'Configuração inválida.' }));
    process.exit(1);
  }
}
