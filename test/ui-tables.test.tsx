// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Agents from '../src/components/Agents';
import IssuesTable from '../src/components/IssuesTable';
import type { AgentSummary, IssueCost, MonitorConfig } from '../server/types';

afterEach(cleanup);

/**
 * The two tables in the monitor. Both had a hole a type could not catch: the cost table pulled itself
 * out of the layout when it had nothing to show, and a subagent row was reachable only with a mouse.
 */

const config = (over: Partial<MonitorConfig> = {}): MonitorConfig => ({
  repo: 'acme/widgets',
  title: 'Widgets',
  runnerRoot: '/tmp/runner',
  transcriptsDir: '/tmp/transcripts',
  commands: {},
  boardSeconds: 300,
  commentSeconds: 120,
  pickupColumn: 'Todo',
  maxActive: 2,
  maxAlive: 3,
  models: { orchestrator: 'fable', implement: 'opus', tester: 'opus', reviewer: 'opus', final: 'fable', status: 'fable', qa: 'opus', e2e: 'opus', smoke: 'fable' },
  qaColumn: '',
  qaAt: '',
  smokeEveryDays: 0,
  smokeAt: '06:00',
  smokeBranch: '',
  ...over,
});

const issue = (over: Partial<IssueCost> = {}): IssueCost => ({
  issue: 42,
  title: 'Add the login screen',
  sessions: 3,
  cost: 1.25,
  tokens: { input: 1000, output: 2000, cacheRead: 30_000 },
  ...over,
});

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId: 'a1',
  prompt: 'implement it',
  description: 'the implementor',
  subagentType: 'implementor',
  model: 'opus',
  usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, thinking: 0 },
  byModel: [],
  toolCounts: { Edit: 4, Bash: 2 },
  turns: 7,
  contextTokens: 50_000,
  lastText: 'pushed the branch',
  ...over,
});

describe('IssuesTable, with nothing costed yet', () => {
  it('says so instead of vanishing — returning null pulled the whole column out of the panel’s row', () => {
    const { container } = render(<IssuesTable issues={[]} config={config()} />);
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByRole('heading', { name: /cost by issue/i })).toBeTruthy();
    expect(screen.getByText(/Nothing costed yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('IssuesTable, with issues', () => {
  it('counts them in the heading and links each one to its issue on GitHub', () => {
    render(<IssuesTable issues={[issue(), issue({ issue: 7, cost: null, title: undefined })]} config={config()} />);
    expect(screen.getByRole('heading', { name: 'cost by issue (2)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '#42' }).getAttribute('href')).toBe('https://github.com/acme/widgets/issues/42');
    expect(screen.getByText('Add the login screen')).toBeTruthy();
    expect(screen.getByText('$1.25')).toBeTruthy();
  });

  it('leaves the number unlinked before Sloth knows which repo it is watching', () => {
    render(<IssuesTable issues={[issue()]} config={config({ repo: '' })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('#42')).toBeTruthy();
  });
});

describe('Agents rows', () => {
  it('says so when the session started none', () => {
    render(<Agents agents={[]} onOpen={vi.fn()} />);
    expect(screen.getByText('This session started no subagents.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('opens a subagent on a click', async () => {
    const onOpen = vi.fn();
    render(<Agents agents={[agent()]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open subagent the implementor' }));
    expect(onOpen).toHaveBeenCalledWith('a1');
  });

  it('opens the same one on Enter and on Space — a row was reachable only with a mouse', () => {
    const onOpen = vi.fn();
    render(<Agents agents={[agent()]} onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: 'Open subagent the implementor' });
    expect(row.tabIndex).toBe(0);
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onOpen.mock.calls).toEqual([['a1'], ['a1']]);
  });

  it('ignores every other key, and a key pressed on something inside the row', () => {
    const onOpen = vi.fn();
    render(<Agents agents={[agent()]} onOpen={onOpen} />);
    const row = screen.getByRole('button', { name: 'Open subagent the implementor' });
    fireEvent.keyDown(row, { key: 'a' });
    fireEvent.keyDown(row, { key: 'Tab' });
    fireEvent.keyDown(screen.getByText('pushed the branch'), { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('names a row after its description, falling back to the id when it has none', () => {
    render(<Agents agents={[agent({ agentId: 'a2', description: undefined })]} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open subagent a2' })).toBeTruthy();
  });
});
