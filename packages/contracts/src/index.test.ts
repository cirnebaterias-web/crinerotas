import { expect, it } from 'vitest';
import { liveResponseSchema } from './index';

it('rejects extra fields and incompatible health responses', () => {
  for (const value of [{ status: 'down' }, { status: 'ok', secret: 'private' }, null, {}]) {
    expect(liveResponseSchema.safeParse(value).success).toBe(false);
  }
  expect(liveResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
});
