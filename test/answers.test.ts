import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answered } from '../server/runner/answers';
import { setDry } from '../server/runner/log';
import { resetSpawn, spawned } from './child-process-mock';
import { onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, card, configure, makeSession, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** A thread as `answerOn` reads it: id, login, body — a `true` third column is a comment of Sloth's, a `false` one somebody else's. */
const tsv = (rows: [number, string, boolean][]) =>
  rows.map(([id, login, sloth]) => [id, login, Buffer.from(sloth ? '**Sloth:** a question' : 'an answer').toString('base64')].join('\t')).join('\n');

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('answered', () => {
  it("relaunches a parked card once a team member replied after Sloth's last comment", async () => {
    onGh(/api repos\/acme\/widgets\/issues\/3\/comments/, tsv([[1, 'alice', false], [2, 'jurat', true], [3, 'mallory', false], [4, 'carol', false], [5, 'bob', false]]));
    await answered([card(3, COLUMNS.needsHelp.name)]);
    expect(spawned[0].args[1]).toBe('/sloth:implement 3 Answer from carol (tester) in the issue thread (comment 4): re-read the whole thread and continue where the last session stopped.');
  });
  it('waits when nobody with a role answered, or Sloth never asked', async () => {
    onGh(/issues\/3\/comments/, tsv([[1, 'jurat', true], [2, 'mallory', false]]));
    onGh(/issues\/4\/comments/, tsv([[1, 'alice', false]]));
    await answered([card(3, COLUMNS.needsHelp.name), card(4, COLUMNS.needsHelp.name)]);
    expect(spawned).toHaveLength(0);
  });
  it('covers a card blocked in place in In Progress, and skips live sessions', async () => {
    makeSession('issue', 5, { blocked: '1' });
    makeSession('issue', 6, { blocked: '1', pid: alivePid() });
    onGh(/issues\/[56]\/comments/, tsv([[1, 'jurat', true], [2, 'bob', false]]));
    await answered([card(5, COLUMNS.inProgress.name), card(6, COLUMNS.inProgress.name), card(7, COLUMNS.inProgress.name)]);
    expect(spawned.map((s) => s.options.env.SLOTH_ISSUE)).toEqual(['5']);
  });
});
