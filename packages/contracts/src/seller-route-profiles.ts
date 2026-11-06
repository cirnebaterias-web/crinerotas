import { z } from 'zod';

export const sellerRouteBaseCitySchema = z.object({
  city: z.string().trim().min(2).max(120),
  state: z.string().regex(/^[A-Z]{2}$/),
  ibgeCode: z.string().regex(/^\d{7}$/),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  reference: z.literal('municipal_seat'),
  source: z.literal('IBGE'),
}).strict();

export const sellerRouteProfileSchema = z.object({
  schemaVersion: z.literal(1),
  sellerId: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  lifecycle: z.enum(['active', 'offboarding_scheduled', 'inactive']),
  offboardingAt: z.iso.datetime({ offset: true }).nullable(),
  baseCity: sellerRouteBaseCitySchema.nullable(),
  portfolioState: z.enum(['assigned', 'unassigned']),
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const updateSellerRouteProfileRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().nonnegative(),
  offboardingAt: z.iso.datetime({ offset: true }).nullable(),
  baseCity: sellerRouteBaseCitySchema.nullable(),
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: z.uuid(),
}).strict();

export const sellerRouteProfileMutationResponseSchema = z.object({
  schemaVersion: z.literal(1), replayed: z.boolean(), profile: sellerRouteProfileSchema,
}).strict();

export type SellerRouteBaseCity = z.infer<typeof sellerRouteBaseCitySchema>;
export type SellerRouteProfile = z.infer<typeof sellerRouteProfileSchema>;
export type UpdateSellerRouteProfileRequest = z.infer<typeof updateSellerRouteProfileRequestSchema>;
export type SellerRouteProfileMutationResponse = z.infer<typeof sellerRouteProfileMutationResponseSchema>;

export const sellerRouteProfilesPath = '/api/v1/administration/seller-route-profiles';
export const sellerRouteProfilePath = (sellerId: string) =>
  `${sellerRouteProfilesPath}/${encodeURIComponent(sellerId)}`;
