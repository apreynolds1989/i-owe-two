// Date ranges. The tracked range (saved in settings) rolls over by itself and builds history; the
// viewing range is a temporary look at other dates that's never saved. Everything here works on
// YYYY-MM-DD strings with UTC arithmetic, so there are no time-zone or DST surprises: "today" is
// worked out by the caller in the person's own time zone.
import { isValidDate, parseWindow, type SprintWindow } from './args';

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
/** Whole days from a to b (negative when b is earlier). */
export const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
/** Days in an inclusive window. */
export const windowDays = (w: SprintWindow) => daysBetween(w.from, w.to) + 1;
export const sameWindow = (a: SprintWindow | null | undefined, b: SprintWindow | null | undefined) =>
  !!a && !!b && a.from === b.from && a.to === b.to;

/**
 * The date `months` calendar months after `start`, on the same day of the month, clamped to the
 * month's length. Always counted from the original start, so a start on the 31st gives Feb 28/29
 * and then Mar 31 again (not Mar 28).
 */
function addMonths(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(year, month, Math.min(d, lastDay)));
}

/** The period of `range` that contains `today`. Works for dates before `start` too (periods repeat backwards). */
export function periodContaining(range: RangeSetting, today: string): SprintWindow {
  switch (range.kind) {
    case 'day':
      return { from: today, to: today };
    case 'week':
    case 'twoWeeks': {
      const len = range.kind === 'week' ? 7 : 14;
      const k = Math.floor(daysBetween(range.start, today) / len);
      const from = shiftDay(range.start, k * len);
      return { from, to: shiftDay(from, len - 1) };
    }
    case 'month':
    case 'year': {
      const step = range.kind === 'month' ? 1 : 12;
      const [sy, sm] = range.start.split('-').map(Number) as [number, number];
      const [ty, tm] = today.split('-').map(Number) as [number, number];
      // A first guess from whole months, then nudged, since clamped month ends can shift it by one.
      let k = Math.floor((ty * 12 + tm - (sy * 12 + sm)) / step);
      if (addMonths(range.start, k * step) > today) k--;
      if (addMonths(range.start, (k + 1) * step) <= today) k++;
      return { from: addMonths(range.start, k * step), to: shiftDay(addMonths(range.start, (k + 1) * step), -1) };
    }
  }
}

/** The period just before `window`. */
export const previousPeriod = (range: RangeSetting, window: SprintWindow) => periodContaining(range, shiftDay(window.from, -1));

/** The window a view shows. */
export function viewWindow(view: ViewRange, tracked: SprintWindow, today: string): SprintWindow {
  switch (view.kind) {
    case 'tracked':
      return tracked;
    case 'lastDays':
      return { from: shiftDay(today, -(view.days - 1)), to: today };
    case 'custom':
      return { from: view.from, to: view.to };
  }
}

export function viewLabel(view: ViewRange): string {
  if (view.kind === 'tracked') return 'My range';
  if (view.kind === 'custom') return 'Custom dates';
  return view.days === 1 ? 'Today' : `Last ${view.days} days`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** Keeps dates to a sensible span, well clear of years Date.UTC treats specially (0–99). */
const plausibleDate = (s: unknown): s is string => typeof s === 'string' && isValidDate(s) && s >= '2000-01-01' && s <= '2100-12-31';

/** A tracked range, accepted only if it's well formed. */
export function validRange(v: unknown): RangeSetting | null {
  if (!isObject(v)) return null;
  const { kind, start } = v;
  if (typeof kind !== 'string' || !(RANGE_KINDS as readonly string[]).includes(kind)) return null;
  if (!plausibleDate(start)) return null;
  return { kind: kind as RangeKind, start };
}

/** A viewing range, or a message saying what's wrong with it. Custom dates keep the usual window limit. */
export function parseView(v: unknown): ViewRange | { error: string } {
  if (!isObject(v)) return { error: 'Invalid range.' };
  if (v.kind === 'tracked') return TRACKED;
  if (v.kind === 'lastDays') {
    const days = LAST_DAYS.find((d) => d === v.days);
    return days ? { kind: 'lastDays', days } : { error: 'Invalid range.' };
  }
  if (v.kind === 'custom') {
    if (typeof v.from !== 'string' || typeof v.to !== 'string') return { error: 'Choose a start and an end date.' };
    if (v.from && !plausibleDate(v.from)) return { error: `Not a valid date: ${v.from}` };
    if (v.to && !plausibleDate(v.to)) return { error: `Not a valid date: ${v.to}` };
    const w = parseWindow(v.from, v.to);
    return 'error' in w ? w : { kind: 'custom', from: w.from, to: w.to };
  }
  return { error: 'Invalid range.' };
}
