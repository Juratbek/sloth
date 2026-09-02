import useUsage from '../../hooks/use-usage';
import { usd } from '../../lib/format';
import { spentOn } from '../UsageChart/utils';

/**
 * What today and the week have cost, in the board header — the chart's hourly series summed, so the
 * board page answers "how much is this costing?" without going back to the home panel. List-price
 * estimate, every run and subagent counted; a model without a list price is flagged, not guessed.
 */
export default function Spend() {
  const { data } = useUsage(7);
  if (!data) return null;
  const unpriced = data.byModel.filter((m) => m.cost === null);
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-zinc-400" title="API list-price estimate over every session and subagent. The home panel has the hours.">
      today <span className="tabular-nums text-zinc-200">{usd(spentOn(data.buckets, new Date()))}</span>
      <span className="text-zinc-600">·</span>7 days <span className="tabular-nums text-zinc-200">{usd(data.cost)}</span>
      {unpriced.length > 0 && (
        <span className="text-amber-400" title={`No list price known for ${unpriced.map((m) => m.model).join(', ')}, so their tokens are not counted.`}>
          excl. {unpriced.length}
        </span>
      )}
    </span>
  );
}
