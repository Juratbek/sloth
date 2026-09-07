import { cfg } from '../config';
import { providerEnv } from '../models';
import { repos } from '../repos';
import { repoName } from '../repo-types';
import { gh, run } from './gh';
import { isDry, log } from './log';

/**
 * Which repository a card with none belongs to — a Trello card, which is a title and a description and
 * names no issue anywhere. With one repository configured there is nothing to choose. With several, the
 * card may name one (its `owner/name`, or a repository's bare name as a word); otherwise the status model
 * is asked, with every repository's note from Settings and its description on GitHub, and answers with a
 * slug. A model that will not answer, or answers with something that is not a repository, leaves the
 * first one — said so in the reason, which goes into the issue the card gets.
 */

export interface RepoChoice {
  slug: string;
  reason: string;
}

const descriptions = new Map<string, string>();

/** The repository's description on GitHub, read once per repository per process. */
async function descriptionOf(slug: string): Promise<string> {
  const known = descriptions.get(slug);
  if (known !== undefined) return known;
  const r = await gh(['repo', 'view', slug, '--json', 'description', '--jq', '.description']);
  const text = r.ok ? r.out.trim() : '';
  descriptions.set(slug, text);
  return text;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A repository the card names itself: its slug anywhere, or its bare name as a whole word when only one has that name. */
function named(text: string): RepoChoice | undefined {
  const list = repos();
  for (const r of list) if (new RegExp(`(^|[^\\w/])${escape(r.slug)}([^\\w]|$)`, 'i').test(text)) return { slug: r.slug, reason: `the card names ${r.slug}` };
  for (const r of list) {
    const name = repoName(r.slug);
    if (list.filter((x) => repoName(x.slug).toLowerCase() === name.toLowerCase()).length !== 1) continue;
    if (new RegExp(`(^|[^\\w/-])${escape(name)}([^\\w-]|$)`, 'i').test(text)) return { slug: r.slug, reason: `the card names ${name}` };
  }
  return undefined;
}

async function prompt(title: string, body: string): Promise<string> {
  const lines: string[] = [];
  for (const r of repos()) {
    const about = [r.note, await descriptionOf(r.slug)].filter(Boolean).join(' — ');
    lines.push(`- ${r.slug}${about ? `: ${about}` : ''}`);
  }
  return [
    'A task has to be done in exactly one of these repositories. Pick the one the task belongs in.',
    '',
    'Repositories:',
    ...lines,
    '',
    `Task title: ${title}`,
    'Task description:',
    body.trim() || '(none)',
    '',
    'Answer with one line: the repository as owner/name, then " — " and one short reason. Nothing else.',
  ].join('\n');
}

/** The model's answer, read for a repository it may name; the last line that names one wins. */
export function parseChoice(answer: string): RepoChoice | undefined {
  const list = repos();
  for (const line of answer.trim().split('\n').reverse()) {
    for (const r of list) {
      if (!line.toLowerCase().includes(r.slug.toLowerCase())) continue;
      const reason = line.split(/\s[—–-]\s/).slice(1).join(' ').trim();
      return { slug: r.slug, reason: reason || 'the model picked it' };
    }
  }
  return undefined;
}

/** Asks the status model; undefined when it did not answer with a repository. */
async function asked(title: string, body: string): Promise<RepoChoice | undefined> {
  const model = cfg().models.status;
  const r = await run('claude', ['-p', await prompt(title, body), '--model', model, '--no-chrome', '--output-format', 'text'], {
    timeout: 180_000,
    env: { ...process.env, ...providerEnv(model, process.env) },
  });
  if (!r.ok) {
    log(`repo choice: ${model} did not answer — ${r.err.split('\n')[0] || 'no output'}`);
    return undefined;
  }
  return parseChoice(r.out);
}

/** The repository for a card that names no issue: the only one, the one the card names, the one the model picks, else the first. */
export async function chooseRepo(title: string, body: string): Promise<RepoChoice> {
  const list = repos();
  if (list.length === 1) return { slug: list[0].slug, reason: 'the only repository' };
  const own = named(`${title}\n${body}`);
  if (own) return own;
  if (isDry()) return { slug: list[0].slug, reason: 'dry run — the first repository' };
  const choice = await asked(title, body);
  if (choice) {
    log(`repo choice: "${title}" → ${choice.slug} (${choice.reason})`);
    return choice;
  }
  log(`repo choice: "${title}" → ${list[0].slug} (the model named no repository; the first one is taken)`);
  return { slug: list[0].slug, reason: 'no repository could be told from the card — the first one is taken' };
}
