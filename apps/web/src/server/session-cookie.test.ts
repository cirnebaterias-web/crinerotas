import { afterEach, expect, it, vi } from 'vitest';
import { sessionCookieOptions } from './identity';

afterEach(() => vi.unstubAllEnvs());
it('allows plain HTTP only for explicitly local origins and defaults to secure', () => {
  for (const base of ['', 'invalid', 'http://remote.example', 'https://127.0.0.1', 'https://example.test']) {
    vi.stubEnv('APP_BASE_URL', base);
    expect(sessionCookieOptions()).toEqual({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
  }
  for (const base of ['http://127.0.0.1:3000', 'http://localhost:3200', 'http://[::1]:3000']) {
    vi.stubEnv('APP_BASE_URL', base);
    expect(sessionCookieOptions().secure).toBe(false);
  }
});
