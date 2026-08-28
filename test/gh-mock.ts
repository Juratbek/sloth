/**
 * Stands in for `server/runner/gh.ts` — every shell-out the runner makes goes through it. Tests register
 * handlers by pattern over the joined argv and read back what was called; unmatched calls succeed with
 * empty output. Install with `vi.mock('../server/runner/gh', () => import('./gh-mock'))`.
 */
export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}
export interface Call {
  cmd: string;
  args: string[];
  line: string;
}
type Reply = Ran | string | object | undefined;
type Handler = (call: Call) => Reply | Promise<Reply>;

export const calls: Call[] = [];
let handlers: { pattern: RegExp; handler: Handler }[] = [];

/** Replies to calls whose `cmd args…` line matches; a string is stdout, an object is JSON stdout, a Ran is itself. */
export function onCommand(pattern: RegExp, reply: Reply | Handler): void {
  handlers.push({ pattern, handler: typeof reply === 'function' ? (reply as Handler) : () => reply });
}
/** Like `onCommand`, for a `gh` call whose argv matches anywhere — across the newlines of a GraphQL query too. */
export const onGh = (pattern: RegExp, reply: Reply | Handler) =>
  onCommand(new RegExp(`^gh [\\s\\S]*${pattern.source}`, pattern.flags.includes('s') ? pattern.flags : `${pattern.flags}s`), reply);
export const fail = (err: string): Ran => ({ ok: false, out: '', err });

export function resetGh(): void {
  calls.length = 0;
  handlers = [];
}
export const linesOf = () => calls.map((c) => c.line);
export const called = (pattern: RegExp) => calls.filter((c) => pattern.test(c.line));

async function dispatch(cmd: string, args: string[]): Promise<Ran> {
  const call = { cmd, args, line: [cmd, ...args].join(' ') };
  calls.push(call);
  for (const { pattern, handler } of handlers) {
    if (!pattern.test(call.line)) continue;
    const r = await handler(call);
    if (r === undefined) continue;
    if (typeof r === 'string') return { ok: true, out: r, err: '' };
    if ('ok' in r && 'out' in r) return r as Ran;
    return { ok: true, out: JSON.stringify(r), err: '' };
  }
  return { ok: true, out: '', err: '' };
}

export const run = (cmd: string, args: string[]) => dispatch(cmd, args);
export const gh = (args: string[]) => dispatch('gh', args);

export async function graphql(query: string, variables: string[] = []): Promise<any> {
  const r = await dispatch('gh', ['api', 'graphql', '-f', `query=${query}`, ...variables]);
  if (!r.ok) throw new Error(r.err || 'gh api graphql failed');
  const parsed = r.out ? JSON.parse(r.out) : {};
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e: { message: string }) => e.message).join('; '));
  return parsed.data ?? parsed;
}
export const graphqlBody = (query: string, variables: Record<string, unknown>) => graphql(query, ['--input', JSON.stringify(variables)]);

export async function comment(repo: string, issue: number, body: string): Promise<boolean> {
  return (await dispatch('gh', ['issue', 'comment', String(issue), '--repo', repo, '--body', body])).ok;
}
