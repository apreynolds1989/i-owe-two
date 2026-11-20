// Period recaps: a short look back at one ended period, built only from what History stored (counts,
// plus teammate logins if the person opted in). Pure, so scripts/check.ts can test it.
import type { SprintWindow } from './args';
import { periodKey, periodRatio, type Period, type Series } from './history';
import { shiftDay } from './range';
import type { ReviewRatio } from './ratio';
import type { Partner } from './types';

export interface Recap {
  period: Period;
  ratio: ReviewRatio;
  /** Change in ratio from the period just before, when both have one and there's no gap between them. */
  delta: number | null;
  /** Back-to-back periods at target or better, ending with this one (0 when this one isn't). */
  streak: number;
  /** The most-traded teammate, only if logins were remembered for this period. */
  topPartner: Partner | null;
}

/**
 * At target or better. A period with nothing authored has no ratio, but reviewing others' PRs while
 * opening none is still doing your share, so it counts; a period with no activity at all doesn't.
 */
const onTarget = (p: Period) => {
  const r = periodRatio(p);
  return r.status === 'good' || r.status === 'super' || (r.status === 'none' && p.reviewed > 0);
};
/** b starts the day after a ends: no missing period between them. */
const followsOn = (a: Period, b: Period) => shiftDay(a.to, 1) === b.from;

export function periodRecap(series: Series, period: Period): Recap {
  const periods = series.periods; // oldest first
  const i = periods.findIndex((p) => periodKey(p) === periodKey(period));
  const before = i > 0 ? periods[i - 1]! : null;
  const ratio = periodRatio(period);
  const prevValue = before && followsOn(before, period) ? periodRatio(before).value : null;
  const delta = ratio.value !== null && prevValue !== null ? Math.round((ratio.value - prevValue) * 100) / 100 : null;

  // A gap (the app wasn't run for a whole period) ends the streak: there's nothing to say it was kept up.
  let streak = 0;
  for (let j = i; j >= 0 && onTarget(periods[j]!); j--) {
    if (j < i && !followsOn(periods[j]!, periods[j + 1]!)) break;
    streak++;
  }

  return { period, ratio, delta, streak, topPartner: period.partners?.[0] ?? null };
}

/**
 * The period whose recap shows on its own: the newest one that has ended and been locked in, unless its
 * recap was already dismissed. Partial periods are left out (their numbers may be incomplete), but can
 * still be opened from History.
 */
export function pendingRecap(series: Series | null, current: SprintWindow | null, seen: string | null): Period | null {
  if (!series || !current) return null;
  const latest = series.periods.filter((p) => p.final && p.to < current.from).at(-1);
  return latest && periodKey(latest) !== seen ? latest : null;
}
