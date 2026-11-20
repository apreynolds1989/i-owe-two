// A look back at one ended period: shown once on its own when a period is locked in, and again from
// History by clicking the period. Everything comes from History (periodRecap in src/shared/recap.ts).
import type { RangeKind } from '../shared/range';
import { RATIO_TARGET, type RatioStatus } from '../shared/ratio';
import type { Recap } from '../shared/recap';
import { shortRange } from './dates';
import { CloseIcon } from './icons';

/** What one period of each range is called, for "3 weeks in a row". */
const UNIT: Record<RangeKind, [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  twoWeeks: ['two-week period', 'two-week periods'],
  month: ['month', 'months'],
  year: ['year', 'years'],
};
/** Plain status words: the live label's "review N more PRs" hint means nothing once a period is over. */
const STATUS: Record<Exclude<RatioStatus, 'none'>, string> = {
  super: 'Super-powered ⚡',
  good: 'On target',
  warn: 'Just under target',
  bad: 'Below target',
};
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

function deltaText(delta: number | null, unit: string): string | null {
  if (delta === null) return null;
  if (delta === 0) return `same as the ${unit} before`;
  return `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)} from the ${unit} before`;
}

/**
 * `onDismiss` adds a close button (the recap that shows on its own); inside History there's none.
 * `title` names the period, e.g. "Last week".
 */
export function RecapCard(props: { recap: Recap; kind: RangeKind; title?: string; onDismiss?: () => void }) {
  const { recap, kind, title, onDismiss } = props;
  const { period: p, ratio, delta, streak, topPartner } = recap;
  const [one, many] = UNIT[kind];
  const change = deltaText(delta, one);

  return (
    <section className={`recap${onDismiss ? ' recap-banner' : ''}`} aria-label={`Recap for ${shortRange(p.from, p.to)}`}>
      {onDismiss && (
        <div className="recap-head">
          <span className="recap-title">
            {title ?? 'Recap'} <span className="muted">· {shortRange(p.from, p.to)}</span>
          </span>
          <button className="icon-button small-icon" onClick={onDismiss} title="Dismiss (it stays in History)" aria-label="Dismiss recap">
            <CloseIcon />
          </button>
        </div>
      )}
      <div className="recap-ratio">
        <span className={`ratio-chip chip-${ratio.status}`}>{ratio.display}</span>
        <span>{ratio.status === 'none' ? (p.reviewed > 0 ? 'Reviewed without opening any PRs' : 'No PRs opened') : STATUS[ratio.status]}</span>
      </div>
      <ul className="recap-lines">
        <li>
          {p.reviewed} reviewed · {p.authored} authored{change && <span className="muted"> · {change}</span>}
        </li>
        {streak >= 2 && (
          <li>
            🔥 {streak} {many} in a row at {RATIO_TARGET.toFixed(1)}+
          </li>
        )}
        {streak === 1 && <li>On target this {one}</li>}
        {(p.reviewedFor !== undefined || p.reviewedBy !== undefined) && (
          <li>
            Reviewed for {people(p.reviewedFor ?? 0)} · {people(p.reviewedBy ?? 0)} reviewed yours
          </li>
        )}
        {topPartner && (
          <li>
            Traded most with @{topPartner.login} <span className="muted">(you {topPartner.gave} · them {topPartner.got})</span>
          </li>
        )}
        {!p.final && <li className="muted">Partial: its final numbers couldn’t be fetched</li>}
      </ul>
    </section>
  );
}
