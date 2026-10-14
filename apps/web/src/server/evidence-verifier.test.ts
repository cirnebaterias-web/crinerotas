import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createEvidenceVerifierClient } from './evidence-verifier';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ trusted: true })) }));

const origin = 'http://127.0.0.1:54321';
const publicKey = 'sb_publishable_synthetic_test_key';
const secretKey = 'sb_secret_synthetic_test_key';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('server-only evidence verifier', () => {
  it('fails closed in production without a privileged server key', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SUPABASE_PUBLIC_URL', origin);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', publicKey);
    vi.stubEnv('CIRNE_SUPABASE_VERIFIER_KEY', '');
    await expect(createEvidenceVerifierClient()).rejects.toThrow('Verificador de evidências indisponível');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('uses the private key only for a server-side client', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SUPABASE_PUBLIC_URL', origin);
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', publicKey);
    vi.stubEnv('CIRNE_SUPABASE_VERIFIER_KEY', secretKey);
    await expect(createEvidenceVerifierClient()).resolves.toEqual({ trusted: true });
    expect(createClient).toHaveBeenCalledWith(origin, secretKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
  });
});
