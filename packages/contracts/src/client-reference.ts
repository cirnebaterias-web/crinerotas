import { z } from 'zod';

/**
 * Preserves generic official identifiers while making formatted CPF/CNPJ values
 * converge with their digits-only representation.
 */
export function normalizeClientExternalReference(value: string) {
  const compact = value.trim().replace(/\s+/g, ' ');
  if (/^[0-9.\-/ ]+$/.test(compact)) return compact.replace(/\D/g, '');
  return compact.toUpperCase();
}

export const clientExternalReferenceSchema = z.string().transform(normalizeClientExternalReference)
  .pipe(z.string().min(1).max(120));
