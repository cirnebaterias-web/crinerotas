import { describe, expect, it } from 'vitest';
import { mergeLocalIdentityEnvironment } from './local-identity-environment';

const values = {
  API_URL: 'http://127.0.0.1:54321',
  PUBLISHABLE_KEY: 'sb_publishable_synthetic',
};

describe('local identity environment', () => {
  it('preserves application settings and replaces public Supabase values once', () => {
    const result = mergeLocalIdentityEnvironment(
      'APP_BASE_URL=http://127.0.0.1:3000\nSUPABASE_PUBLIC_URL=http://localhost:1\n' +
      'SUPABASE_PUBLISHABLE_KEY=replace-me\nLOG_LEVEL=debug\n',
      values,
    );
    expect(result).toContain('APP_BASE_URL=http://127.0.0.1:3000');
    expect(result).toContain('OPERATIONAL_TIME_ZONE=America/Sao_Paulo');
    expect(result).toContain('LOG_LEVEL=debug');
    expect(result.match(/^SUPABASE_PUBLIC_URL=/gm)).toHaveLength(1);
    expect(result).toContain(`SUPABASE_PUBLISHABLE_KEY=${values.PUBLISHABLE_KEY}`);
  });

  it('rejects remote origins and privileged keys', () => {
    expect(() => mergeLocalIdentityEnvironment('', { ...values, API_URL: 'https://example.com' }))
      .toThrow(/somente a origem/);
    expect(() => mergeLocalIdentityEnvironment('SUPABASE_SECRET_KEY=do-not-store\n', values))
      .toThrow(/chave privilegiada/);
    expect(() => mergeLocalIdentityEnvironment('', { ...values, PUBLISHABLE_KEY: 'sb_secret_nope' }))
      .toThrow(/chave publica/);
  });

  it('normalizes the public key before persisting it', () => {
    expect(mergeLocalIdentityEnvironment('', {
      ...values,
      PUBLISHABLE_KEY: `  ${values.PUBLISHABLE_KEY}  `,
    })).toContain(`SUPABASE_PUBLISHABLE_KEY=${values.PUBLISHABLE_KEY}\n`);
  });

  it('preserves an explicitly configured operational time zone', () => {
    const result = mergeLocalIdentityEnvironment('OPERATIONAL_TIME_ZONE=UTC\n', values);
    expect(result.match(/^OPERATIONAL_TIME_ZONE=/gm)).toHaveLength(1);
    expect(result).toContain('OPERATIONAL_TIME_ZONE=UTC');
  });
});
