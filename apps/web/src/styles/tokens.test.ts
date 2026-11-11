import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = readonly [number, number, number];

function token(source: string, name: string) {
  const match = source.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`Token --${name} ausente ou sem valor hexadecimal direto.`);
  return match[1];
}

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as Rgb;
}

function luminance(hex: string) {
  const channels = rgb(hex).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

describe('Cirne Momentum tokens', () => {
  const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

  it.each([
    ['on-primary', 'primary'],
    ['on-action', 'action'],
    ['on-surface', 'surface'],
    ['on-surface-muted', 'surface'],
    ['success', 'success-container'],
    ['warning', 'warning-container'],
    ['error', 'error-container'],
    ['info', 'info-container'],
    ['focus', 'surface'],
  ])('keeps --color-%s readable on --color-%s', (foreground, background) => {
    expect(contrast(token(source, `color-${foreground}`), token(source, `color-${background}`))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps compatibility aliases and reduced-motion overrides explicit', () => {
    expect(source).toContain('--cirne-red: var(--color-error)');
    expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    expect(source).toContain('--motion-standard: 0.01ms');
  });
});
