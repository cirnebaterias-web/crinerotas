import { z } from 'zod';

export const liveResponseSchema = z.object({ status: z.literal('ok') }).strict();
export type LiveResponse = z.infer<typeof liveResponseSchema>;
export const livePath = '/api/v1/health/live';

export const roleCodeSchema = z.enum(['seller', 'manager', 'administrator']);
export const userStatusSchema = z.enum(['active', 'inactive']);
export const meResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(roleCodeSchema),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)),
  scopeIds: z.array(z.uuid()),
  status: userStatusSchema,
}).strict();
export type MeResponse = z.infer<typeof meResponseSchema>;
export const mePath = '/api/v1/me';

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    recoverable: z.boolean(),
    timestamp: z.iso.datetime({ offset: true }),
    requestId: z.uuid(),
  }).strict(),
}).strict();
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
