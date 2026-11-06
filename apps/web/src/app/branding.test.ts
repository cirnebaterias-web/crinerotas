import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const appRoot = new URL('../../', import.meta.url);

describe('Cirne Rotas browser identity', () => {
  it('declares the official app icon as the global favicon', async () => {
    const layout = await readFile(new URL('src/app/layout.tsx', appRoot), 'utf8');

    expect(layout).toContain("url: '/icons/app-icon.svg'");
    expect(layout).toContain("shortcut: '/icons/app-icon.svg'");
  });

  it('keeps the favicon aligned with the route symbol used by the brand', async () => {
    const [icon, brand] = await Promise.all([
      readFile(new URL('public/icons/app-icon.svg', appRoot), 'utf8'),
      readFile(new URL('src/features/auth/brand.tsx', appRoot), 'utf8'),
    ]);
    const routePath = 'M11 25V15a5 5 0 0 1 5-5h9M19 7l6 3-6 3M25 17v4a5 5 0 0 1-5 5h-3';

    expect(icon).toContain(routePath);
    expect(brand).toContain(routePath);
    expect(icon).toContain('fill="#00783b"');
    expect(icon).toContain('stroke="#fff"');
  });
});
