import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The one convention in the README that a reader cannot check by reading: "source files stay under 300
 * lines". A file that grows past it is a module that has taken on a second job — the split is easy while
 * it is one file over, and a rewrite by the time it is three. Tests are not walked: a test file is a list
 * of cases and gets longer honestly as the behaviour it covers grows.
 */

const LIMIT = 300;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WALKED = ['server', 'src'];
const SKIP = new Set(['node_modules', 'dist']);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').length;

describe('the file-size rule', () => {
  it('walks the source tree at all — a wrong root would pass this file every time', () => {
    const files = WALKED.flatMap((dir) => sources(path.join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
  });

  it(`keeps every file in ${WALKED.join('/ ')} under ${LIMIT} lines`, () => {
    const over = WALKED.flatMap((dir) => sources(path.join(ROOT, dir)))
      .map((file) => ({ file: path.relative(ROOT, file), lines: lines(file) }))
      .filter((f) => f.lines >= LIMIT)
      .sort((a, b) => b.lines - a.lines)
      .map((f) => `${f.file} (${f.lines})`);
    expect(over).toEqual([]);
  });
});
