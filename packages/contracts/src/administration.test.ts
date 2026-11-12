import { describe, expect, it } from 'vitest';
import {
  administrationSnapshotSchema, createAdministrationUserRequestSchema,
  resetAdministrationPasswordRequestSchema, updateAdministrationUserRequestSchema,
} from './administration';

const id = '10000000-0000-4000-8000-000000000001';
const updatedAt = '2026-10-30T03:00:00.000Z';

describe('administration contracts', () => {
  it('accepts a strict sanitized snapshot', () => {
    expect(administrationSnapshotSchema.safeParse({
      schemaVersion: 1, generatedAt: updatedAt,
      users: [{ id, displayName: 'Vendedor', status: 'active', blockedAt: null, updatedAt,
        roles: ['seller'], sellerScopeIds: [], lastAdministrativeChange: null }],
      roles: [{ code: 'seller', name: 'Vendedor' }],
      parameters: { mutationAvailability: 'blocked_pending_business_approval',
        blockers: ['AB-02', 'AB-03', 'AB-09'], current: null },
    }).success).toBe(true);
  });

  it('rejects secrets and inconsistent user states', () => {
    const base = { id, displayName: 'Vendedor', status: 'active', blockedAt: null, updatedAt,
      roles: ['seller'], sellerScopeIds: [], lastAdministrativeChange: null };
    expect(administrationSnapshotSchema.safeParse({ schemaVersion: 1, generatedAt: updatedAt,
      users: [{ ...base, email: 'private@example.test' }], roles: [{ code: 'seller', name: 'Vendedor' }],
      parameters: { mutationAvailability: 'blocked_pending_business_approval',
        blockers: ['AB-02', 'AB-03', 'AB-09'], current: null } }).success).toBe(false);
    expect(administrationSnapshotSchema.shape.users.element.safeParse({
      ...base, status: 'inactive', blockedAt: null,
    }).success).toBe(false);
  });

  it('requires a reason, unique roles and manager-only scopes', () => {
    const base = { schemaVersion: 1, expectedUpdatedAt: updatedAt, status: 'active',
      roles: ['manager'], sellerScopeIds: [id], reason: 'Ajuste aprovado para o piloto',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    expect(updateAdministrationUserRequestSchema.safeParse(base).success).toBe(true);
    expect(updateAdministrationUserRequestSchema.safeParse({ ...base, roles: ['seller'] }).success).toBe(false);
    expect(updateAdministrationUserRequestSchema.safeParse({ ...base, roles: ['manager', 'manager'] }).success).toBe(false);
    expect(updateAdministrationUserRequestSchema.safeParse({ ...base, reason: 'curto' }).success).toBe(false);
  });

  it('validates provisioning credentials without ever accepting weak passwords', () => {
    const create = { schemaVersion: 1, displayName: 'Novo Vendedor', email: 'NOVO@EXAMPLE.COM',
      password: 'Temporaria#2026', roles: ['seller'], reason: 'Provisionamento aprovado pelo gestor',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    expect(createAdministrationUserRequestSchema.parse(create).email).toBe('novo@example.com');
    expect(createAdministrationUserRequestSchema.safeParse({ ...create, password: 'fraca' }).success).toBe(false);
    expect(resetAdministrationPasswordRequestSchema.safeParse({ schemaVersion: 1,
      password: 'OutraSenha#2026', reason: create.reason, idempotencyKey: create.idempotencyKey }).success).toBe(true);
  });
});
