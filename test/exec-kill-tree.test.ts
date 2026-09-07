import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => import('./child-process-mock'));

import { run } from '../server/exec';
import { executed, resetSpawn } from './child-process-mock';

/**
 * `execFile`'s own timeout signals the one process it started. A `gh repo clone` ended that way leaves
 * its `git` writing on, so a caller may ask for the whole tree to go instead: the child then leads its
 * own process group and the timeout is Sloth's timer, not `execFile`'s.
 */
describe('run with killTree', () => {
  beforeEach(resetSpawn);

  it('starts the child as a group leader and keeps the timeout to itself', async () => {
    await run('gh', ['repo', 'clone', 'acme/widgets', '/tmp/x'], { timeout: 5000, killTree: true });
    const call = executed.find((e) => e.line.startsWith('gh repo clone'))!;
    expect(call.options.detached).toBe(process.platform !== 'win32');
    expect(call.options.timeout).toBeUndefined();
  });

  it('leaves every other call as it was', async () => {
    await run('gh', ['auth', 'status'], { timeout: 5000 });
    const call = executed.find((e) => e.line.startsWith('gh auth status'))!;
    expect(call.options.detached).toBeUndefined();
    expect(call.options.timeout).toBe(5000);
  });
});
