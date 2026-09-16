import { describe, expect, it } from 'vitest';
import { readIdentityConfig, readServerConfig } from './server';
import * as publicConfig from './public';

describe('configuration boundaries', () => {
  it('requires a valid origin without exposing invalid inputs', () => {
    for (const APP_BASE_URL of [undefined, 'secret-value', 'ftp://example.com', 'https://user:password@example.com', 'http://localhost/path', 'http://localhost?token=secret']) {
      expect(() => readServerConfig({ APP_BASE_URL, OPERATIONAL_TIME_ZONE: 'America/Sao_Paulo' }))
        .toThrow('Configuração inválida: APP_BASE_URL.');
    }
  });
  it('requires an explicit valid IANA operational time zone', () => {
    expect(() => readServerConfig({ APP_BASE_URL: 'http://localhost:3000' }))
      .toThrow('OPERATIONAL_TIME_ZONE');
    expect(() => readServerConfig({
      APP_BASE_URL: 'http://localhost:3000',
      OPERATIONAL_TIME_ZONE: 'synthetic-invalid-zone',
    })).toThrow('OPERATIONAL_TIME_ZONE');
  });
  it('validates log level and discards unrelated privileged configuration', () => {
    const base = { APP_BASE_URL: 'http://localhost:3000', OPERATIONAL_TIME_ZONE: 'America/Sao_Paulo' };
    expect(() => readServerConfig({ ...base, LOG_LEVEL: 'secret' })).toThrow('LOG_LEVEL');
    expect(readServerConfig({ ...base, SUPABASE_SECRET_KEY: 'private' })).toEqual({
      ...base,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });
  it('public exports do not expose server configuration', () => {
    expect(Object.keys(publicConfig)).toEqual(['productName']);
  });
  it('loads only the public Supabase connection for caller-scoped access', () => {
    const env = {
      SUPABASE_PUBLIC_URL: 'http://127.0.0.1:54321',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value',
      SUPABASE_SECRET_KEY: 'must-not-be-returned',
    };
    expect(readIdentityConfig(env)).toEqual({
      SUPABASE_PUBLIC_URL: env.SUPABASE_PUBLIC_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    });
    expect(() => readIdentityConfig({ ...env, SUPABASE_PUBLIC_URL: 'https://user:secret@example.com' }))
      .toThrow('SUPABASE_PUBLIC_URL');
  });
});
