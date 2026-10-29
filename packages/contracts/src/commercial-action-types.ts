import { z } from 'zod';

export const competitorCommercialActionTypes = [
  'differentiated_price',
  'seller_or_driver_incentive',
  'retailer_incentive',
  'purchase_combo',
  'other',
] as const;

export const competitorCommercialActionTypeSchema = z.enum(competitorCommercialActionTypes);
export type CompetitorCommercialActionType = z.infer<typeof competitorCommercialActionTypeSchema>;
