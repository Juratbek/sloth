import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { writeAtomic } from '../server/atomic';
import { write } from '../server/runner/log';
import { configure, read, wipe } from './harness';

/**
 * `server/atomic.ts` — every file Sloth reads back is replaced whole or not at all. The interesting case
 * is the one that fails halfway: the reader must still find the file it had, not an empty one.
 */

let dir: string;

beforeEach(() => {
  dir = configure().stateDir;
  wipe();
  fs.mkdirSync(dir, { recursive: true });
});

describe('writeAtomic', () => {
  it('writes the file and leaves no temporary beside it', () => {
    const file = path.join(dir, 'deep', 'marker');
    writeAtomic(file, 'done');
    expect(read(file)).toBe('done');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['marker']);
  });

  it('leaves the file that was there untouched when the write cannot finish', () => {
    const file = path.join(dir, 'state.json');
    writeAtomic(file, '{"state":"working"}');
    // Something in the way of the temporary — a full disk, a permission, a leftover directory — is the
    // shape of every interrupted write: the old content has to survive it.
    fs.mkdirSync(`${file}.tmp`);
    expect(() => writeAtomic(file, '{"state":"done"}')).toThrow();
    expect(read(file)).toBe('{"state":"working"}');
  });

  it('is what the runner writes its state files with', () => {
    // `write` in `runner/log.ts` is the one call every marker, pid and `state.json` goes through.
    const file = path.join(dir, 'markers', 'handed', '9-abc');
    write(file, '');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['9-abc']);
  });
});
