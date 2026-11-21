// Date ranges. The tracked range (saved in settings) rolls over by itself and builds history; the
// viewing range is a temporary look at other dates that's never saved. Everything here works on
// YYYY-MM-DD strings with UTC arithmetic, so there are no time-zone or DST surprises: "today" is
// worked out by the caller in the person's own time zone.
import { isValidDate, parseWindow, type DateWindow } from './dateWindow';
import { isObject } from './validate';

export type RangeKind = 'day' | 'week' | 'twoWeeks' | 'month' | 'year';
export const RANGE_KINDS: readonly RangeKind[] = ['day', 'week', 'twoWeeks', 'month', 'year'];
export const RANGE_LABELS: Record<RangeKind, string> = {
  day: 'Day',
  week: 'Week',
  twoWeeks: 'Two weeks',
  month: 'Month',
  year: 'Year',
};

/** The tracked range: periods of one kind, lined up with `start` (a period begins on it). */
export interface RangeSetting {
  kind: RangeKind;
  start: string;
}

/** A temporary look at other dates. 'lastDays' windows end today; Today is lastDays 1. */
export type ViewRange =
  | { kind: 'tracked' }
  | { kind: 'lastDays'; days: LastDays }
  | { kind: 'custom'; from: string; to: string };
export const LAST_DAYS = [1, 7, 14, 30] as const;
export type LastDays = (typeof LAST_DAYS)[number];
export const TRACKED: ViewRange = Object.freeze({ kind: 'tracked' });

const DAY_MS = 86_400_000;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Shift a YYYY-MM-DD date by whole days. */
export const shiftDay = (ymd: string, days: number) => fromMs(toMs(ymd) + days * DAY_MS);
/** Whole days from `from` to `to` (negative when `to` is earlier). */
const daysBetween = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY_MS);
/** Days in an inclusive window. */
export const windowDays = (window: DateWindow) => daysBetween(window.from, window.to) + 1;
export const sameWindow = (a: DateWindow | null | undefined, b: DateWindow | null | undefined) =>
  !!a && !!b && a.from === b.from && a.to === b.to;

/**
 * The date `months` calendar months after `start`, on the same day of the month, clamped to the
 * month's length. Always counted from the original start, so a start on the 31st gives Feb 28/29
 * and then Mar 31 again (not Mar 28).
 */
function addMonths(start: string, months: number): string {
  const [startYear, startMonth, startDay] = start.split('-').map(Number) as [number, number, number];
  // Count in months since year 0, so the year carries over without special cases.
  const monthIndex = startYear * 12 + (startMonth - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12; // 0-based
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(year, month, Math.min(startDay, lastDayOfMonth)));
}

/** The period of `range` that contains `today`. Works for dates before `start` too (periods repeat backwards). */
export function periodContaining(range: RangeSetting, today: string): DateWindow {
  switch (range.kind) {
    case 'day':
      return { from: today, to: today };
    case 'week':
    case 'twoWeeks': {
      const periodDays = range.kind === 'week' ? 7 : 14;
      // Negative before `start`: Math.floor rounds towards the earlier period.
      const periodIndex = Math.floor(daysBetween(range.start, today) / periodDays);
      const from = shiftDay(range.start, periodIndex * periodDays);
      return { from, to: shiftDay(from, periodDays - 1) };
    }
    case 'month':
    case 'year': {
      const monthsPerPeriod = range.kind === 'month' ? 1 : 12;
      const [startYear, startMonth] = range.start.split('-').map(Number) as [number, number];
      const [todayYear, todayMonth] = today.split('-').map(Number) as [number, number];
      // A first guess from whole months, then nudged, since clamped month ends can shift it by one.
      let periodIndex = Math.floor((todayYear * 12 + todayMonth - (startYear * 12 + startMonth)) / monthsPerPeriod);
      if (addMonths(range.start, periodIndex * monthsPerPeriod) > today) periodIndex--;
      if (addMonths(range.start, (periodIndex + 1) * monthsPerPeriod) <= today) periodIndex++;
      return {
        from: addMonths(range.start, periodIndex * monthsPerPeriod),
        to: shiftDay(addMonths(range.start, (periodIndex + 1) * monthsPerPeriod), -1),
      };
    }
  }
}

/** The window a view shows. */
export function viewWindow(view: ViewRange, tracked: DateWindow, today: string): DateWindow {
  switch (view.kind) {
    case 'tracked':
      return tracked;
    case 'lastDays':
      return { from: shiftDay(today, -(view.days - 1)), to: today };
    case 'custom':
      return { from: view.from, to: view.to };
  }
}

/** What the Viewing picker calls a view: "My range", "Today", "Last 7 days", "Custom dates". */
export function viewLabel(view: ViewRange): string {
  if (view.kind === 'tracked') return 'My range';
  if (view.kind === 'custom') return 'Custom dates';
  return view.days === 1 ? 'Today' : `Last ${view.days} days`;
}

/** Keeps dates to a sensible span, well clear of years Date.UTC treats specially (0–99). */
const plausibleDate = (value: unknown): value is string =>
  typeof value === 'string' && isValidDate(value) && value >= '2000-01-01' && value <= '2100-12-31';

/** A tracked range, accepted only if it's well formed. */
export function validRange(value: unknown): RangeSetting | null {
  if (!isObject(value)) return null;
  const { kind, start } = value;
  if (typeof kind !== 'string' || !(RANGE_KINDS as readonly string[]).includes(kind)) return null;
  if (!plausibleDate(start)) return null;
  return { kind: kind as RangeKind, start };
}

/** A viewing range, or a message saying what's wrong with it. Custom dates keep the usual window limit. */
export function parseView(value: unknown): ViewRange | { error: string } {
  if (!isObject(value)) return { error: 'Invalid range.' };
  if (value.kind === 'tracked') return TRACKED;
  if (value.kind === 'lastDays') {
    const days = LAST_DAYS.find((offered) => offered === value.days);
    return days ? { kind: 'lastDays', days } : { error: 'Invalid range.' };
  }
  if (value.kind === 'custom') {
    if (typeof value.from !== 'string' || typeof value.to !== 'string') return { error: 'Choose a start and an end date.' };
    if (value.from && !plausibleDate(value.from)) return { error: `Not a valid date: ${value.from}` };
    if (value.to && !plausibleDate(value.to)) return { error: `Not a valid date: ${value.to}` };
    const window = parseWindow(value.from, value.to);
    return 'error' in window ? window : { kind: 'custom', from: window.from, to: window.to };
  }
  return { error: 'Invalid range.' };
}
