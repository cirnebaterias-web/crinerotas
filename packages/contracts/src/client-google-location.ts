import { z } from 'zod';

// Source metadata, not a verified storefront or an observed seller position.
export const googlePlaceIdSchema = z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const clientGoogleLocationSchema = z.object({
  address: z.string().trim().min(1).max(500).nullable(),
  placeId: googlePlaceIdSchema.nullable(),
  status: z.string().trim().min(1).max(120).nullable(),
  precision: z.string().trim().min(1).max(80).nullable(),
}).strict();

export type ClientGoogleLocation = z.infer<typeof clientGoogleLocationSchema>;
