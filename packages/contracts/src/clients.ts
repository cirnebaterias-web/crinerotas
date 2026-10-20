import { z } from 'zod';
import { clientExternalReferenceSchema } from './client-reference';

export const clientStatusSchema = z.enum(['active', 'archived']);
const clientNameSchema = z.string().trim().min(1).max(160);
const clientAddressSchema = z.string().trim().min(1).max(300);
const clientPortfolioReferenceSchema = z.string().trim().max(120)
  .transform((value) => value || null).nullable();
const sellerEmailSchema = z.email().max(254).transform((value) => value.toLowerCase());

const clientMutableFields = {
  name: clientNameSchema,
  address: clientAddressSchema,
  latitude: z.number().finite().min(-90).max(90).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
  portfolioReference: clientPortfolioReferenceSchema,
  sellerEmail: sellerEmailSchema,
  status: clientStatusSchema,
} as const;

function coordinatesArePaired(
  value: { latitude: number | null; longitude: number | null },
  context: z.RefinementCtx,
) {
  if ((value.latitude === null) !== (value.longitude === null)) {
    context.addIssue({
      code: 'custom',
      path: [value.latitude === null ? 'latitude' : 'longitude'],
      message: 'Latitude e longitude devem ser informadas juntas.',
    });
  }
}

export const createClientRequestSchema = z.object({
  schemaVersion: z.literal(1),
  externalReference: clientExternalReferenceSchema,
  ...clientMutableFields,
}).strict().superRefine(coordinatesArePaired);

export const updateClientRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  ...clientMutableFields,
}).strict().superRefine(coordinatesArePaired);

export const clientDetailSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  externalReference: clientExternalReferenceSchema,
  name: clientNameSchema,
  address: clientAddressSchema,
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  portfolioReference: z.string().max(120).nullable(),
  sellerId: z.uuid().nullable(),
  sellerEmail: z.email().nullable(),
  status: clientStatusSchema,
  version: z.number().int().positive(),
}).strict();

export const clientMutationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  replayed: z.boolean(),
  client: clientDetailSchema,
}).strict();

export const clientSellerSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  email: z.email(),
}).strict();

export const clientSellerListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  sellers: z.array(clientSellerSchema).max(500),
}).strict();

export const clientOpsResultSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('ok'),
  clientId: z.uuid(),
  createdVersion: z.number().int().positive(),
  updatedVersion: z.number().int().positive(),
  checks: z.object({
    created: z.literal(true),
    replayed: z.literal(true),
    queried: z.literal(true),
    updated: z.literal(true),
    staleConflict: z.literal(true),
  }).strict(),
}).strict();

export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;
export type ClientDetail = z.infer<typeof clientDetailSchema>;
export type ClientMutationResponse = z.infer<typeof clientMutationResponseSchema>;
export type ClientSeller = z.infer<typeof clientSellerSchema>;

export const clientsPath = '/api/v1/clients';
export const clientPath = (clientId: string) => `${clientsPath}/${encodeURIComponent(clientId)}`;
export const clientSellersPath = `${clientsPath}/sellers`;
