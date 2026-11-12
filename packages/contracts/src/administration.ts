import { z } from 'zod';

export const administrationRoleCodeSchema = z.enum(['seller', 'manager', 'administrator', 'logistics']);
export const administrationStatusSchema = z.enum(['active', 'inactive']);

export const administrationUserSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  status: administrationStatusSchema,
  blockedAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  roles: z.array(administrationRoleCodeSchema).min(1).max(4),
  sellerScopeIds: z.array(z.uuid()).max(500),
  auth: z.object({
    email: z.email(), emailConfirmed: z.boolean(),
    lastSignInAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict().nullable().optional(),
  lastAdministrativeChange: z.object({
    action: z.literal('identity.access.updated.v1'),
    reason: z.string().trim().min(1).max(500),
    occurredAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
}).strict().superRefine((user, context) => {
  if (!user.roles.includes('manager') && user.sellerScopeIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['sellerScopeIds'], message: 'Somente Gestor possui escopos.' });
  }
  if ((user.status === 'active') !== (user.blockedAt === null)) {
    context.addIssue({ code: 'custom', path: ['blockedAt'], message: 'Bloqueio incompatível com o status.' });
  }
});

export const administrationParameterValueSchema = z.object({
  id: z.uuid(), category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(120), sortOrder: z.number().int().nonnegative(),
}).strict();

export const administrationSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime({ offset: true }),
  users: z.array(administrationUserSchema).max(10_000),
  roles: z.array(z.object({
    code: administrationRoleCodeSchema, name: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(4),
  parameters: z.object({
    mutationAvailability: z.literal('blocked_pending_business_approval'),
    blockers: z.tuple([z.literal('AB-02'), z.literal('AB-03'), z.literal('AB-09')]),
    current: z.object({
      parameterSetId: z.uuid(), version: z.number().int().positive(),
      validFrom: z.iso.datetime({ offset: true }),
      values: z.array(administrationParameterValueSchema).max(1000),
    }).strict().nullable(),
  }).strict(),
}).strict();

export const updateAdministrationUserRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  status: administrationStatusSchema,
  roles: z.array(administrationRoleCodeSchema).min(1).max(4)
    .refine((roles) => new Set(roles).size === roles.length, 'Papéis repetidos.'),
  sellerScopeIds: z.array(z.uuid()).max(500)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Escopos repetidos.'),
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.uuid(),
}).strict().superRefine((command, context) => {
  if (!command.roles.includes('manager') && command.sellerScopeIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['sellerScopeIds'], message: 'Somente Gestor possui escopos.' });
  }
});

export const updateAdministrationUserResultSchema = z.object({
  schemaVersion: z.literal(1), replayed: z.boolean(), user: administrationUserSchema,
}).strict();

const credentialPasswordSchema = z.string().min(12).max(128);
export const createAdministrationUserRequestSchema = z.object({
  schemaVersion: z.literal(1), displayName: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()), password: credentialPasswordSchema,
  roles: z.array(administrationRoleCodeSchema).min(1).max(4)
    .refine((roles) => new Set(roles).size === roles.length, 'Papeis repetidos.'),
  reason: z.string().trim().min(10).max(500), idempotencyKey: z.uuid(),
}).strict();
export const createAdministrationUserResultSchema = z.object({
  schemaVersion: z.literal(1), replayed: z.boolean(), user: administrationUserSchema,
}).strict();
export const resetAdministrationPasswordRequestSchema = z.object({
  schemaVersion: z.literal(1), password: credentialPasswordSchema,
  reason: z.string().trim().min(10).max(500), idempotencyKey: z.uuid(),
}).strict();
export const resetAdministrationPasswordResultSchema = z.object({
  schemaVersion: z.literal(1), replayed: z.boolean(), userId: z.uuid(),
}).strict();

export type AdministrationRoleCode = z.infer<typeof administrationRoleCodeSchema>;
export type AdministrationUser = z.infer<typeof administrationUserSchema>;
export type AdministrationSnapshot = z.infer<typeof administrationSnapshotSchema>;
export type UpdateAdministrationUserRequest = z.infer<typeof updateAdministrationUserRequestSchema>;
export type UpdateAdministrationUserResult = z.infer<typeof updateAdministrationUserResultSchema>;
export type CreateAdministrationUserRequest = z.infer<typeof createAdministrationUserRequestSchema>;
export type CreateAdministrationUserResult = z.infer<typeof createAdministrationUserResultSchema>;
export type ResetAdministrationPasswordRequest = z.infer<typeof resetAdministrationPasswordRequestSchema>;
export type ResetAdministrationPasswordResult = z.infer<typeof resetAdministrationPasswordResultSchema>;

export const administrationPath = '/api/v1/administration';
export const administrationUserPath = (userId: string) => `${administrationPath}/users/${userId}`;
export const administrationUserPasswordPath = (userId: string) => `${administrationUserPath(userId)}/password`;
