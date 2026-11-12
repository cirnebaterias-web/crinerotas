import { createClient } from '@supabase/supabase-js';
import { readAuthAdminConfig } from '@cirne/config/server';

export type AdministrationAuthUser = {
  id: string; email: string; emailConfirmed: boolean; lastSignInAt: string | null;
};

export interface AdministrationAuthGateway {
  listUsers(): Promise<AdministrationAuthUser[]>;
  createUser(input: { email: string; password: string; displayName: string; idempotencyKey: string }):
    Promise<AdministrationAuthUser & { created: boolean }>;
  deleteUser(userId: string): Promise<void>;
  updatePassword(userId: string, password: string): Promise<void>;
}

export function createAdministrationAuthGateway(): AdministrationAuthGateway {
  const config = readAuthAdminConfig(process.env);
  const client = createClient(config.SUPABASE_PUBLIC_URL, config.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const project = (user: { id: string; email?: string; email_confirmed_at?: string;
    last_sign_in_at?: string; app_metadata?: Record<string, unknown> }): AdministrationAuthUser => {
    if (!user.email) throw new Error('Identidade Auth sem email.');
    return { id: user.id, email: user.email.toLowerCase(), emailConfirmed: Boolean(user.email_confirmed_at),
      lastSignInAt: user.last_sign_in_at ?? null };
  };
  async function allUsers() {
    const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw new Error('Diretorio Auth indisponivel.');
    return data.users;
  }
  return {
    async listUsers() { return (await allUsers()).map(project); },
    async createUser(input) {
      const { data, error } = await client.auth.admin.createUser({
        email: input.email, password: input.password, email_confirm: true,
        user_metadata: { displayName: input.displayName },
        app_metadata: { cirneProvisioningKey: input.idempotencyKey },
      });
      if (!error && data.user) return { ...project(data.user), created: true };
      const existing = (await allUsers()).find((user) => user.email?.toLowerCase() === input.email &&
        user.app_metadata?.cirneProvisioningKey === input.idempotencyKey);
      if (existing) return { ...project(existing), created: false };
      throw new Error('Nao foi possivel criar a identidade Auth.');
    },
    async deleteUser(userId) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error) throw new Error('Nao foi possivel compensar a identidade Auth.');
    },
    async updatePassword(userId, password) {
      const { error } = await client.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error('Nao foi possivel redefinir a credencial Auth.');
    },
  };
}
