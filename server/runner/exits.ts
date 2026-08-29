import path from 'node:path';
import { nowSec, readFile, remove, write } from './log';
import { stateOf } from './session-dirs';

/**
 * Every `claude` run appends its output to the session's run.log behind one of these lines, so one log
 * holds the history of an issue's attempts and the newest attempt can be told from the ones before it.
 */
const HEADER = '=== sloth run ';
export const runHeader = (model: string): string => `${HEADER}${new Date().toISOString()} · ${model} ===\n`;

/** The output of the newest run in a log: what follows the last header, or the whole log from before headers existed. */
export function lastRun(runLog: string | undefined): string {
  if (!runLog) return '';
  const at = runLog.lastIndexOf(HEADER);
  if (at < 0) return runLog;
  const eol = runLog.indexOf('\n', at);
  return eol < 0 ? '' : runLog.slice(eol + 1);
}

/** How one run of an issue ended: its last `state.json` and what it printed before it went. */
export interface Exit {
  at: number;
  how: string;
  step?: string;
  note?: string;
  tail: string;
}

const TAIL = 1500; // characters of a run's last words kept for the comment — the end says what was left
const exitsFile = (dir: string) => path.join(dir, 'exits.json');

export function exitsOf(dir: string): Exit[] {
  try {
    const list = JSON.parse(readFile(exitsFile(dir)) ?? '') as unknown;
    return Array.isArray(list) ? (list as Exit[]) : [];
  } catch {
    return [];
  }
}

/**
 * Remembers how the run in `dir` ended, for the comment that parks the card after the last relaunch:
 * the step and note the session last wrote, and the end of its own final report. A `claude -p` run
 * prints its last message on the way out, so a session that ran out of time and said what it left
 * undone is quoted back to the human instead of surfacing as a bare "stopped N times".
 */
export function recordExit(dir: string, how: string): Exit {
  const { step, note } = stateOf(dir);
  const out = lastRun(readFile(path.join(dir, 'run.log'))).trim();
  const exit: Exit = { at: nowSec(), how, step, note, tail: out.length > TAIL ? `…${out.slice(-TAIL)}` : out };
  write(exitsFile(dir), JSON.stringify([...exitsOf(dir), exit]));
  return exit;
}

export const forgetExits = (dir: string): void => remove(exitsFile(dir));

/** One line for the log: `the session ended on its own at step 4 (running the tester)`. */
export const exitLine = (e: Exit): string => `${e.how}${e.step ? ` at step ${e.step}` : ''}${e.note ? ` (${e.note})` : ''}`;

/** Markdown for the parking comment: one collapsed section per run, the session's last words inside. */
export function exitReport(dir: string): string {
  const exits = exitsOf(dir);
  return exits
    .map((e, i) => {
      const when = `${new Date(e.at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      const body = e.tail ? `\`\`\`\n${e.tail.replace(/```/g, "'''")}\n\`\`\`` : '_The session printed nothing before it ended._';
      return `<details>\n<summary>Run ${i + 1} of ${exits.length} — ${exitLine(e)}, ${when}</summary>\n\n${body}\n\n</details>`;
    })
    .join('\n');
}
