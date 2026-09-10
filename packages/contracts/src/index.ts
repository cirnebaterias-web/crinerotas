import { z } from 'zod';

export const liveResponseSchema = z.object({ status: z.literal('ok') }).strict();
export type LiveResponse = z.infer<typeof liveResponseSchema>;
export const livePath = '/api/v1/health/live';
