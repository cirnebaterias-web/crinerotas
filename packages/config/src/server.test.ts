import { describe, expect, it } from 'vitest';
import { readServerConfig } from './server';
import * as publicConfig from './public';

describe('configuration boundaries', () => {
  it('requires a valid origin without exposing invalid inputs', () => {
    for (const APP_BASE_URL of [undefined, 'secret-value', 'ftp://example.com', 'https://user:password@example.com', 'http://localhost/path', 'http://localhost?token=secret']) {
      expect(() => readServerConfig({ APP_BASE_URL })).toThrow('Configuração inválida: APP_BASE_URL.');
    }
  });
  it('validates log level and discards unrelated privileged configuration', () => {
    expect(() => readServerConfig({ APP_BASE_URL: 'http://localhost:3000', LOG_LEVEL: 'secret' })).toThrow('LOG_LEVEL');
    expect(readServerConfig({ APP_BASE_URL: 'http://localhost:3000', SUPABASE_SECRET_KEY: 'private' })).toEqual({ APP_BASE_URL: 'http://localhost:3000', NODE_ENV: 'development', LOG_LEVEL: 'info' });
  });
  it('public exports do not expose server configuration', () => {
    expect(Object.keys(publicConfig)).toEqual(['productName']);
  });
});
