import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import type { CookieMethodsServer } from '@supabase/ssr';
import type { MeResponse } from '@cirne/contracts';
import { resolveIdentityRequest } from '../../server/identity';
import { ManagementShell } from './management-shell';

export async function ManagementLayout({ children }: { children: ReactNode }) {
  let identity: MeResponse | null = null;
  try {
    const store = await cookies();
    const cookieMethods: CookieMethodsServer = {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: () => { /* Layout rendering never mutates the session. */ },
    };
    identity = await resolveIdentityRequest(null, cookieMethods);
  } catch { /* Child pages retain their own explicit forbidden/error states. */ }
  return <ManagementShell initialIdentity={identity}>{children}</ManagementShell>;
}
