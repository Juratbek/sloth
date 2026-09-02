import { describe, expect, it } from 'vitest';
import { queued } from '../src/lib/queued';

const at = (line: string) => `[2026-09-02T10:00:00.000Z] ${line}`;

describe('queued (the chip on the home panel)', () => {
  it('counts a card from its queued line until it launches', () => {
    expect(queued([at('#5 queued (slots full)')])).toEqual(['#5']);
    expect(queued([at('#5 queued (slots full)'), at('launch #5 on opus')])).toEqual([]);
    expect(queued([at('review PR #9 queued (machine busy: memory 91%)'), at('review PR #9 (issue #3) on fable')])).toEqual([]);
    expect(queued([at('QA #5 queued (no free worktree slot)'), at('launch QA #5 on opus (qa @ abc1234)')])).toEqual([]);
  });
  it('drops a card that left the queue without launching: a dry run, a stop, a park in place, a status reply', () => {
    expect(queued([at('#5 queued (slots full)'), at('dry-run: would launch #5')])).toEqual([]);
    expect(queued([at('#5 queued (slots full)'), at('#5 stopped: from the monitor')])).toEqual([]);
    expect(queued([at('#5 queued (slots full)'), at('#5 parked in place (no needs-help column configured)')])).toEqual([]);
    expect(queued([at('QA #5 queued (slots full)'), at('QA #5 stopped: the QA branch moved')])).toEqual([]);
    expect(queued([at('#4 status reply for comment 9 queued (slots full)'), at('#4 status reply for comment 9 on #4')])).toEqual([]);
  });
  it('keeps the kinds apart: a QA run queued on a card is not the implement run of the same card', () => {
    expect(queued([at('QA #5 queued (slots full)'), at('launch #5 on opus')])).toEqual(['QA #5']);
  });
});
