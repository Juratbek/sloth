import { NumberInput, TextInput, inputStyle } from '../setup/ui';
import { Row } from './ui';
import type { SectionProps } from './ui';

/** The schedule as a person says it. */
export const everyLabel = (days: number) => (days < 1 ? 'off' : days === 1 ? 'daily' : days === 7 ? 'weekly' : days === 14 ? 'every two weeks' : `every ${days} days`);

/**
 * The scheduled smoke test (trigger 11): how often, when, on which branch, with what budget, and what to
 * walk through. Off until a number of days is set; Test now on the home panel runs one regardless.
 */
export default function SmokeSection({ draft, patch }: SectionProps) {
  const smoke = (p: Partial<typeof draft.smoke>) => patch({ smoke: { ...draft.smoke, ...p } });
  return (
    <>
      <p className="py-3 text-xs text-zinc-400">
        On a schedule Sloth smoke-tests the whole app for a release: one session checks the branch out, boots the app and has the browser
        tester walk the main flows of every user role — happy paths only, through the real UI. It ends with a GO / NO-GO report on a
        report issue in the repository, with screenshots; blockers and major findings become issues of their own, added to the board with
        no status for you to triage. Nothing on the board moves.{' '}
        {draft.smoke.everyDays < 1 && <span className="text-amber-300">Not scheduled — set the days below, or use Test now on the home panel.</span>}
      </p>
      <Row label="Every N days" hint="Days between two runs: 1 is daily, 2 every second day, 7 weekly. 0 turns the schedule off.">
        <NumberInput min={0} value={draft.smoke.everyDays} onChange={(everyDays) => smoke({ everyDays })} />
      </Row>
      <Row label="Time of day" hint="When a due run starts, on this machine's clock — 06:00 unless changed, so the report is there when the day starts.">
        <input type="time" aria-label="Time of day" value={draft.smoke.at} onChange={(e) => smoke({ at: e.target.value })} className={inputStyle} />
      </Row>
      <Row label="Branch" hint="The branch under test — the one you are about to release. Empty means the repository's default branch.">
        <TextInput value={draft.smoke.branch} onChange={(branch) => smoke({ branch })} placeholder="default branch" />
      </Row>
      <Row label="Budget minutes" hint="The session's time budget: one app boot, then one browser pass per role. Five minutes past it the session is killed; the next scheduled run goes ahead as planned.">
        <NumberInput value={draft.smoke.budgetMinutes} onChange={(budgetMinutes) => smoke({ budgetMinutes })} />
      </Row>
      <Row
        label="What to smoke"
        hint="The roles and their main flows, one role per line — e.g. “RECEPTIONIST: /reception — patient search, booking, check-in”. Empty, the session reads the roles and flows off the project's own docs and skills."
        wide
      >
        <textarea
          aria-label="What to smoke"
          value={draft.smoke.brief}
          onChange={(e) => smoke({ brief: e.target.value })}
          rows={6}
          spellCheck={false}
          placeholder={'ADMIN: /dashboard — staff, settings, reports\nCASHIER: /billing — invoices, payments, refunds'}
          className={`${inputStyle} font-mono text-xs`}
        />
      </Row>
    </>
  );
}
