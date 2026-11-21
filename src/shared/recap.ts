// Period recaps: a short look back at one ended period, built only from what History stored (counts,
// plus teammate logins if the person opted in). Pure, so scripts/check.ts can test it.
import type { DateWindow } from './dateWindow';
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
const onTarget = (period: Period) => {
  const ratio = periodRatio(period);
  return ratio.status === 'good' || ratio.status === 'super' || (ratio.status === 'none' && period.reviewed > 0);
};
/** `later` starts the day after `earlier` ends: no missing period between them. */
const followsOn = (earlier: Period, later: Period) => shiftDay(earlier.to, 1) === later.from;

/** The recap for one period of a series: its ratio, the change from the period before, and the streak. */
export function periodRecap(series: Series, period: Period): Recap {
  const periods = series.periods; // oldest first
  const index = periods.findIndex((candidate) => periodKey(candidate) === periodKey(period));
  const before = index > 0 ? periods[index - 1]! : null;
  const ratio = periodRatio(period);
  const previousValue = before && followsOn(before, period) ? periodRatio(before).value : null;
  const delta = ratio.value !== null && previousValue !== null ? Math.round((ratio.value - previousValue) * 100) / 100 : null;

  // Walk back from this period. A gap (the app wasn't run for a whole period) ends the streak: there's
  // nothing to say it was kept up.
  let streak = 0;
  for (let earlier = index; earlier >= 0 && onTarget(periods[earlier]!); earlier--) {
    if (earlier < index && !followsOn(periods[earlier]!, periods[earlier + 1]!)) break;
    streak++;
  }

  return { period, ratio, delta, streak, topPartner: period.partners?.[0] ?? null };
}

/**
 * The period whose recap shows on its own: the newest one that has ended and been locked in, unless its
 * recap was already dismissed. Partial periods are left out (their numbers may be incomplete), but can
 * still be opened from History.
 */
export function pendingRecap(series: Series | null, current: DateWindow | null, seen: string | null): Period | null {
  if (!series || !current) return null;
  const latest = series.periods.filter((period) => period.final && period.to < current.from).at(-1);
  return latest && periodKey(latest) !== seen ? latest : null;
}
