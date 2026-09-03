import { gh, run } from './runner/gh';

/**
 * The GitHub side of the comment webhook: the three calls that read, create and update the repository
 * hook. Kept apart from `webhook.ts` so the decision — is there a public address, what does the status
 * say, which interval is in force — reads without the shape of GitHub's API in the way.
 *
 * Every payload travels down stdin (`gh api --input -`) rather than argv: the shared secret would
 * otherwise sit in `ps` for anyone with an account on this machine to read. The two mutations use `run`
 * and not the retrying `gh`: a create attempted twice because the first answer was lost is a second
 * webhook on the repository, and every comment delivered twice for ever.
 */

/**
 * The path GitHub delivers to. Only this end of the address is ever matched against an existing hook —
 * a quick tunnel gets a new host on every start, so the host says nothing about whose hook it is.
 */
export const HOOK_PATH = '/api/hooks/github';

/**
 * All Sloth asks to hear about: an `@sloth` mention is a comment on an issue or on a PR — in its
 * conversation (`issue_comment`) or on a line of its diff (`pull_request_review_comment`) — and nothing else.
 */
export const EVENTS = ['issue_comment', 'pull_request_review_comment'];

/** One repository webhook, with the two fields Sloth looks at. */
export interface RepoHook {
  id: number;
  config?: { url?: string };
}

/** The first line with anything on it — what `gh` said, without the stack of hints underneath it. */
export const firstLine = (...texts: string[]): string => {
  for (const text of texts) for (const line of text.split('\n')) if (line.trim()) return line.trim();
  return '';
};

const hookConfig = (url: string, secret: string) => ({ url, content_type: 'json', secret, insecure_ssl: '0' });

/**
 * Every webhook on the repository. A token that may not see them answers 404 rather than 403 — GitHub
 * hides what it will not show — which is why the reason a failure carries is worth passing on verbatim.
 */
export async function listHooks(repo: string): Promise<RepoHook[]> {
  const r = await gh(['api', `repos/${repo}/hooks`]);
  if (!r.ok) throw new Error(firstLine(r.err, r.out) || `gh api repos/${repo}/hooks failed`);
  try {
    const hooks: unknown = JSON.parse(r.out || '[]');
    return Array.isArray(hooks) ? (hooks as RepoHook[]) : [];
  } catch {
    throw new Error('the webhook list did not come back as JSON');
  }
}

/** A new hook pointing at `url`; the id GitHub gave it comes back. */
export async function createHook(repo: string, url: string, secret: string): Promise<number> {
  const body = JSON.stringify({ name: 'web', active: true, events: EVENTS, config: hookConfig(url, secret) });
  const r = await run('gh', ['api', '-X', 'POST', `repos/${repo}/hooks`, '--input', '-', '--jq', '.id'], { stdin: body });
  if (!r.ok) throw new Error(firstLine(r.err, r.out) || 'creating the webhook failed');
  return Number(r.out.trim()) || 0;
}

/** The hook Sloth already owns, pointed at today's address and given today's secret. */
export async function updateHook(repo: string, id: number, url: string, secret: string): Promise<void> {
  const body = JSON.stringify({ active: true, events: EVENTS, config: hookConfig(url, secret) });
  const r = await run('gh', ['api', '-X', 'PATCH', `repos/${repo}/hooks/${id}`, '--input', '-'], { stdin: body });
  if (!r.ok) throw new Error(firstLine(r.err, r.out) || 'updating the webhook failed');
}
