import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette in `src/index.css` is now the only place a Sloth colour is decided, which makes deleting
 * a token from it a silent way to break a component: Tailwind drops the utility, the class stays in the
 * JSX, and the element renders with no colour at all rather than failing to build. This file is the
 * receipt — the names the UI is written against, listed once, so a rename has to be deliberate.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');

/** The `@theme { … }` block, which is where a token counts; a `--color-*` anywhere else is not a token. */
const theme = CSS.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const tokens = new Map([...theme.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));

const NAMES = [
  'surface',
  'surface-raised',
  'surface-inset',
  'edge',
  'edge-strong',
  'edge-focus',
  'fg',
  'fg-strong',
  'fg-soft',
  'fg-muted',
  'fg-faint',
  'fg-disabled',
  'accent',
  'ok',
  'ok-fg',
  'ok-edge',
  'ok-edge-strong',
  'ok-tint',
  'warn',
  'warn-fg',
  'warn-edge',
  'warn-edge-strong',
  'warn-tint',
  'warn-tint-strong',
  'danger',
  'danger-fg',
  'danger-edge',
  'danger-tint',
  'info',
  'info-fg',
  'info-fg-strong',
  'info-edge',
  'info-edge-strong',
  'info-tint',
  'info-tint-strong',
];

describe('the design tokens', () => {
  it('parses the @theme block at all — an empty match would pass every case below', () => {
    expect(theme).toContain('--color-surface');
    expect(tokens.size).toBeGreaterThanOrEqual(NAMES.length);
  });

  it.each(NAMES)('defines --color-%s', (name) => {
    expect(tokens.get(`--color-${name}`)).toBeTruthy();
  });

  it('keeps every token an alias of a Tailwind shade, so the rendered colours cannot drift', () => {
    // `--color-surface` is the documented exception: `use-remote.ts` reads it for the QR code, and the
    // encoder needs a hex where `getPropertyValue` on an alias would answer with an oklch.
    const odd = [...tokens].filter(([name, value]) => name !== '--color-surface' && !/^var\(--color-[a-z]+-\d+\)$/.test(value));
    expect(odd).toEqual([]);
    expect(tokens.get('--color-surface')).toBe('#09090b');
  });

  it('is what the QR code reads, so the page and the code stay the same colour', () => {
    const remote = fs.readFileSync(path.join(ROOT, 'src/hooks/use-remote.ts'), 'utf8');
    expect(remote).toContain("getPropertyValue('--color-surface')");
    expect(remote).not.toContain('#09090b');
  });
});
