import { NumberInput, TextInput, inputStyle } from '../setup/ui';
import { Row } from './ui';
import type { SectionProps } from './ui';

/**
 * The daily QA sweep (trigger 9): which branch the merged fixes are tested on, when, and how long each
 * test may take. The column it sweeps is picked in the Board section — without one, nothing here runs.
 */
export default function QaSection({ draft, patch }: SectionProps) {
  const qa = (p: Partial<typeof draft.qa>) => patch({ qa: { ...draft.qa, ...p } });
  const column = draft.statusField.columns.qa;
  return (
    <>
      <p className="py-3 text-xs text-zinc-400">
        Once a day Sloth tests every card in the QA column: each gets a session of its own that checks the QA branch out, boots the app
        and clicks through the fix as a user would. A pass moves the card to Done, a fail puts the findings on the issue and the card
        back in In Progress, where a new implement run picks them up.{' '}
        {column.id ? (
          <>
            The column is <span className="text-zinc-200">{column.name}</span> — change it in Board.
          </>
        ) : (
          <span className="text-amber-300">No QA column is chosen yet — pick one in Board, or nothing here runs.</span>
        )}
      </p>
      <Row label="Time of day" hint="When the sweep starts, on this machine's clock — 20:00 unless changed, once the day's merges are deployed. Empty turns the sweep off; Sweep now on the home panel runs one regardless.">
        <input
          type="time"
          aria-label="Time of day"
          value={draft.qa.at}
          onChange={(e) => qa({ at: e.target.value })}
          className={inputStyle}
        />
      </Row>
      <Row label="Branch" hint="The branch the fixes are deployed from and tested on — qa, staging… Empty means the repository's default branch.">
        <TextInput value={draft.qa.branch} onChange={(branch) => qa({ branch })} placeholder="default branch" />
      </Row>
      <Row label="Budget minutes" hint="One QA session's time budget: one issue, one app boot, one browser run. Five minutes past it the session is killed and the card is tested again next sweep.">
        <NumberInput value={draft.qa.budgetMinutes} onChange={(budgetMinutes) => qa({ budgetMinutes })} />
      </Row>
    </>
  );
}
