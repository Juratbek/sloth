import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answered } from '../server/runner/answers';
import { setBotLogin } from '../server/runner/bot';
import { setDry } from '../server/runner/log';
import { resetSpawn, spawned } from './child-process-mock';
import { onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, card, configure, makeSession, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** A thread as `answerOn` reads it: id, login, body — a `true` third column is a comment of Sloth's, a `false` one somebody else's. */
const tsv = (rows: [number, string, boolean][]) =>
  rows.map(([id, login, sloth]) => [id, login, Buffer.from(sloth ? '**Sloth:** a question' : 'an answer').toString('base64')].join('\t')).join('\n');

/** The same, with the body spelled out — for a comment that wears Sloth's prefix without being Sloth's. */
const thread = (rows: [number, string, string][]) =>
  rows.map(([id, login, body]) => [id, login, Buffer.from(body).toString('base64')].join('\t')).join('\n');

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

  it('covers a card blocked in place in every worked column, not only In Progress', async () => {
    // `park` is called with the card in Code Review (a review given up or stopped) and in Approved (a PR
    // closed unmerged) too, and blocks it where it stands when the needs-help move is refused or there is
    // no such column. Only In Progress used to be scanned, so those cards sat there for ever and answering
    // in the thread did nothing, although the park comment said it would.
    for (const n of [8, 9, 10]) makeSession('issue', n, { blocked: '1' });
    onGh(/issues\/(8|9|10)\/comments/, tsv([[1, 'jurat', true], [2, 'bob', false]]));
    await answered([card(8, COLUMNS.codeReview.name), card(9, COLUMNS.approved.name), card(10, COLUMNS.pickup.name)]);
    expect(spawned.map((s) => s.options.env.SLOTH_ISSUE).sort()).toEqual(['10', '8', '9']);
  });

  it('a comment is only Sloth’s question when Sloth wrote it', async () => {
    // The prefix alone is anyone's to type: `**Sloth:** ok` from any account that may comment reset the
    // answer scan, so the tester's real answer under it counted for nothing and the card waited for ever.
    setBotLogin('sloth-bot');
    try {
      onGh(/issues\/11\/comments/, thread([
        [1, 'sloth-bot', '**Sloth:** what should the button say?'],
        [2, 'carol', 'call it Save'],
        [3, 'mallory', '**Sloth:** ok'],
      ]));
      await answered([card(11, COLUMNS.needsHelp.name)]);
      expect(spawned[0]?.args[1]).toMatch(/Answer from carol \(tester\) in the issue thread \(comment 2\)/);
    } finally {
      setBotLogin(undefined);
    }
  });

  it('falls back to the prefix while the login Sloth writes as is unknown', async () => {
    // Reading Sloth's own comments as a stranger's would be the worse failure: the run would answer itself.
    onGh(/issues\/12\/comments/, thread([[1, 'sloth-bot', '**Sloth:** a question'], [2, 'carol', 'an answer']]));
    await answered([card(12, COLUMNS.needsHelp.name)]);
    expect(spawned[0]?.args[1]).toMatch(/comment 2/);
  });
});
