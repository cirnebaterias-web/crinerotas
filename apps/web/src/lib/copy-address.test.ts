import { afterEach, expect, it, vi } from 'vitest';
import { copyAddress } from './copy-address';

afterEach(() => vi.useRealTimers());

it('confirms only after the exact address has been copied', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  expect(await copyAddress('Rua São José, 100', { writeText })).toBe(true);
  expect(writeText).toHaveBeenCalledWith('Rua São José, 100');
});

it('falls back on denied, missing or synchronous clipboard failure', async () => {
  expect(await copyAddress('Rua 1', undefined)).toBe(false);
  expect(await copyAddress('Rua 1', { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).toBe(false);
  expect(await copyAddress('Rua 1', { writeText: () => { throw new Error('denied'); } })).toBe(false);
  const writeText = vi.fn();
  expect(await copyAddress(' ', { writeText })).toBe(false);
  expect(writeText).not.toHaveBeenCalled();
});

it('does not leave a pending permission prompt blocking manual fallback indefinitely', async () => {
  vi.useFakeTimers();
  const result = copyAddress('Rua 1', { writeText: () => new Promise(() => {}) });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(await result).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
