import { describe, expect, it } from 'vitest';
import { fitStockPhotoDimensions, formatPhotoBytes } from './stock-photo-compression';

describe('stock photo compression limits', () => {
  it('limits the longest side to 1600 pixels without enlarging the image', () => {
    expect(fitStockPhotoDimensions(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitStockPhotoDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('formats the compressed size for field feedback', () => {
    expect(formatPhotoBytes(350 * 1024)).toBe('350 KB');
    expect(formatPhotoBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('rejects invalid dimensions', () => {
    expect(() => fitStockPhotoDimensions(0, 10)).toThrow('dimensões');
  });
});
