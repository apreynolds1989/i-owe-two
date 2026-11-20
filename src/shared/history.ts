// Review history: one series of periods per tracked range. A series is identified by owner, login,
// range kind and start date together, because periods from different ones can't be compared. At most
// one series is active (it matches the current settings); the others are archived and read-only.
// Counts only: no PR titles or links are stored. Everything here is pure (no Electron, no files), so
// scripts/check.ts can test it; src/main/history.ts reads and writes the file.
import { isValidDate, type SprintWindow } from './args';
import { reviewRatio, superMinReviews, type ReviewRatio } from './ratio';
import { RANGE_KINDS, RANGE_LABELS, windowDays, type RangeKind } from './range';
import type { HistoryChoice, SprintSettings } from './types';
import { isValidLogin } from './validate';

/** Bump when the file format changes, and convert older versions in parseHistory. */
export const HISTORY_VERSION = 1;
/** Across all series. The oldest archived periods go first, then the oldest active ones. */
export const MAX_PERIODS = 500;

export interface Period {
  from: string;
  to: string;
  authored: number;
  reviewed: number;
  /** True once the period ended and its numbers were fetched one last time. */
  final: boolean;
  updatedAt: string;
}

export interface Series {
  owner: string;
  login: string;
  kind: RangeKind;
  start: string;
  startedAt: string;
  /** null for the active series. */
  archivedAt: string | null;
  /** Oldest first. */
  periods: Period[];
}

export interface History {
  version: number;
  series: Series[];
}

/** What the UI is sent. */
export interface HistoryView {
  /** The series for the current settings, if it has started. */
  active: Series | null;
  /** Most recently archived first. */
  archived: Series[];
  /** The file was written by a newer version of the app, so this one leaves it alone. */
  readOnly: boolean;
}

export const EMPTY_HISTORY: History = Object.freeze({ version: HISTORY_VERSION, series: [] }) as History;

type SeriesKey = Pick<Series, 'owner' | 'login' | 'kind' | 'start'>;
export const seriesId = (s: SeriesKey) => [s.owner.toLowerCase(), s.login.toLowerCase(), s.kind, s.start].join('|');
const keyOf = (s: SprintSettings): SeriesKey => ({ owner: s.owner, login: s.login, kind: s.range.kind, start: s.range.start });

const isActive = (s: Series) => s.archivedAt === null;
const activeOf = (h: History) => h.series.find(isActive) ?? null;

// ---------- reading a file that may have been hand-edited or corrupted ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;

function parsePeriod(v: unknown): Period | null {
  if (!isObject(v)) return null;
  const { from, to, authored, reviewed, final, updatedAt } = v;
  if (typeof from !== 'string' || typeof to !== 'string' || !isValidDate(from) || !isValidDate(to) || from > to) return null;
  if (!isCount(authored) || !isCount(reviewed) || typeof final !== 'boolean' || !isTime(updatedAt)) return null;
  return { from, to, authored, reviewed, final, updatedAt };
}

function parseSeries(v: unknown): Series | null {
  if (!isObject(v)) return null;
  const { owner, login, kind, start, startedAt, archivedAt, periods } = v;
  if (typeof owner !== 'string' || !isValidLogin(owner) || typeof login !== 'string' || !isValidLogin(login)) return null;
  if (typeof kind !== 'string' || !(RANGE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof start !== 'string' || !isValidDate(start) || !isTime(startedAt)) return null;
  if (archivedAt !== null && !isTime(archivedAt)) return null;
  if (!Array.isArray(periods)) return null;
  const valid = periods.map(parsePeriod).filter((p): p is Period => p !== null);
  // One entry per period, oldest first.
  const unique = [...new Map(valid.map((p) => [`${p.from}|${p.to}`, p])).values()].sort((a, b) => a.from.localeCompare(b.from));
  return { owner, login, kind: kind as RangeKind, start, startedAt, archivedAt, periods: unique };
}

/** History from the file's parsed JSON. Anything invalid is dropped rather than trusted. */
export function parseHistory(raw: unknown): { history: History; readOnly: boolean } {
  if (!isObject(raw)) return { history: EMPTY_HISTORY, readOnly: false };
  // Written by a newer version (after a downgrade): don't guess at its format, and never overwrite it.
  if (typeof raw.version === 'number' && raw.version > HISTORY_VERSION) return { history: EMPTY_HISTORY, readOnly: true };
  const parsed = (Array.isArray(raw.series) ? raw.series : []).map(parseSeries).filter((s): s is Series => s !== null);
  const seen = new Set<string>();
  let haveActive = false;
  const series = parsed.flatMap((s) => {
    const id = seriesId(s);
    if (seen.has(id)) return [];
    seen.add(id);
    // Only one series can be active; any extra one is treated as archived.
    if (isActive(s)) {
      if (haveActive) return [{ ...s, archivedAt: s.startedAt }];
      haveActive = true;
    }
    return [s];
  });
  return { history: { version: HISTORY_VERSION, series }, readOnly: false };
}

// ---------- changes (each returns a new History; nothing is modified in place) ----------

/** When saving `settings` would retire history that has periods, what the UI should ask about. */
export function needsChoice(h: History, settings: SprintSettings): HistoryChoice | null {
  const a = activeOf(h);
  if (!a || seriesId(a) === seriesId(keyOf(settings)) || a.periods.length === 0) return null;
  return { kind: a.kind, start: a.start, periods: a.periods.length };
}

/**
 * Makes `settings` the active series: the current one is archived (or deleted), and an archived series
 * with exactly these settings is resumed. A new series is only created once it has a period to hold.
 */
export function switchSeries(h: History, settings: SprintSettings, choice: 'archive' | 'delete', now: string): History {
  const id = seriesId(keyOf(settings));
  const a = activeOf(h);
  let series = h.series;
  if (a && seriesId(a) !== id) {
    series =
      choice === 'delete' || a.periods.length === 0
        ? series.filter((s) => s !== a)
        : series.map((s) => (s === a ? { ...s, archivedAt: now } : s));
  }
  if (!series.some(isActive)) {
    const match = series.find((s) => seriesId(s) === id);
    if (match) series = series.map((s) => (s === match ? { ...s, archivedAt: null } : s));
  }
  return series === h.series ? h : { ...h, series };
}

/** Adds or updates one period of the active series. A final period is never replaced by a non-final one. */
export function recordPeriod(
  h: History,
  settings: SprintSettings,
  p: Pick<Period, 'from' | 'to' | 'authored' | 'reviewed' | 'final'>,
  now: string,
): History {
  const switched = switchSeries(h, settings, 'archive', now);
  const existing = activeOf(switched);
  const a: Series = existing ?? { ...keyOf(settings), startedAt: now, archivedAt: null, periods: [] };
  const same = (x: Period) => x.from === p.from && x.to === p.to;
  if (a.periods.find(same)?.final && !p.final) return switched;
  const periods = [...a.periods.filter((x) => !same(x)), { ...p, updatedAt: now }].sort((x, y) => x.from.localeCompare(y.from));
  const updated = { ...a, periods };
  const series = existing ? switched.series.map((s) => (s === existing ? updated : s)) : [...switched.series, updated];
  return capPeriods({ ...switched, series });
}

/** Keeps the total under MAX_PERIODS: oldest archived periods first, then the oldest active ones. */
export function capPeriods(h: History): History {
  let excess = h.series.reduce((n, s) => n + s.periods.length, 0) - MAX_PERIODS;
  if (excess <= 0) return h;
  const archived = h.series.filter((s) => !isActive(s)).sort((a, b) => a.archivedAt!.localeCompare(b.archivedAt!));
  const trimmed = new Map<Series, Period[]>();
  for (const s of [...archived, ...h.series.filter(isActive)]) {
    if (excess <= 0) break;
    const drop = Math.min(excess, s.periods.length);
    trimmed.set(s, s.periods.slice(drop));
    excess -= drop;
  }
  const series = h.series
    .map((s) => (trimmed.has(s) ? { ...s, periods: trimmed.get(s)! } : s))
    .filter((s) => isActive(s) || s.periods.length > 0);
  return { ...h, series };
}

// ---------- reading ----------

/**
 * The most recent period of the active series that has ended (before `current`) but wasn't finalized:
 * it gets fetched one last time to lock in its numbers.
 */
export function pendingFinalize(h: History, settings: SprintSettings, current: SprintWindow): Period | null {
  const a = activeOf(h);
  if (!a || seriesId(a) !== seriesId(keyOf(settings))) return null;
  return a.periods.filter((p) => !p.final && p.to < current.from).at(-1) ?? null;
}

export function historyView(h: History, readOnly: boolean, settings: SprintSettings | null): HistoryView {
  const a = activeOf(h);
  return {
    active: a && settings && seriesId(a) === seriesId(keyOf(settings)) ? a : null,
    archived: h.series.filter((s) => !isActive(s)).sort((x, y) => y.archivedAt!.localeCompare(x.archivedAt!)),
    readOnly,
  };
}

/** A period's ratio, judged with the super minimum for its own length. */
export const periodRatio = (p: Period): ReviewRatio => reviewRatio(p.reviewed, p.authored, superMinReviews(windowDays(p)));

/** Every series and period as CSV (active series first). Every field is quoted. */
export function historyCsv(h: History): string {
  const quote = (v: string | number | boolean) => `"${String(v).replaceAll('"', '""')}"`;
  const rows: Array<Array<string | number | boolean>> = [
    ['owner', 'login', 'range', 'range_start', 'status', 'from', 'to', 'authored', 'reviewed', 'ratio', 'final'],
  ];
  const ordered = [...h.series.filter(isActive), ...h.series.filter((s) => !isActive(s))];
  for (const s of ordered) {
    for (const p of s.periods) {
      const r = periodRatio(p);
      rows.push([s.owner, s.login, RANGE_LABELS[s.kind], s.start, isActive(s) ? 'active' : 'archived', p.from, p.to, p.authored, p.reviewed, r.value === null ? '' : r.display, p.final]);
    }
  }
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
