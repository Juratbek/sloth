import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { which } from '../server/install';
import { root } from './harness';

/**
 * `which` resolves the tools Sloth shells out to — `git`, `gh`, the tunnel, and by way of `sudo.ts` the
 * `install` and `visudo` that go into a `sudo` command line. What it may never do is resolve one of them
 * relative to the checkout it is running in.
 */
let was: string | undefined;
let dir: string;

beforeEach(() => {
  was = process.env.PATH;
  dir = fs.mkdtempSync(path.join(root(), 'bin-'));
});
afterEach(() => {
  process.env.PATH = was;
});

const executable = (where: string, name: string) => {
  const file = path.join(where, name);
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
};

describe('which', () => {
  it('ignores an empty PATH entry instead of resolving the command against the current directory', () => {
    // A trailing colon is common, and to a shell it means the working directory. Here it used to make
    // `path.join('', 'sudo')` a bare name that `fs.accessSync` resolved against Sloth's own checkout, so
    // a file called `sudo`, `git` or `install` committed to the watched project was run as that tool.
    const cwd = process.cwd();
    const planted = executable(cwd, 'sloth-fake-tool');
    try {
      process.env.PATH = `${dir}${path.delimiter}`;
      expect(which('sloth-fake-tool')).toBeUndefined();
    } finally {
      fs.rmSync(planted, { force: true });
    }
  });

  it('still finds a command on a PATH entry that is there', () => {
    executable(dir, 'sloth-real-tool');
    process.env.PATH = `${dir}${path.delimiter}`;
    expect(which('sloth-real-tool')).toBe(path.join(dir, 'sloth-real-tool'));
  });
});
