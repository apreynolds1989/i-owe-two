// Review history: one series of periods per tracked range. A series is identified by owner, login,
// range kind and start date together, because periods from different ones can't be compared. At most
// one series is active (it matches the current settings); the others are archived and read-only.
// Counts only by default: no PR titles or links are ever stored, and teammates' logins only when the person
// opts in ("Remember teammates in history"; see `partners`). Everything here is pure (no Electron, no
// files), so scripts/check.ts can test it; src/main/history.ts reads and writes the file.
import { isValidDate, type SprintWindow } from './args';
import { reviewRatio, superMinReviews, type ReviewRatio } from './ratio';
import { RANGE_KINDS, RANGE_LABELS, windowDays, type RangeKind } from './range';
import type { HistoryChoice, Partner, SprintSettings } from './types';
import { isValidLogin } from './validate';

/** Bump when the file format changes, and convert older versions in parseHistory. */
export const HISTORY_VERSION = 1;
/** Across all series. The oldest archived periods go first, then the oldest active ones. */
export const MAX_PERIODS = 500;
/** Opt-in teammate logins kept per period: just enough for a recap, not a full record of who reviews whom. */
export const MAX_STORED_PARTNERS = 5;

export interface Period {
  from: string;
  to: string;
  authored: number;
  reviewed: number;
  /** True once the period ended and its numbers were fetched one last time. */
  final: boolean;
  updatedAt: string;
  /** How many people this person reviewed PRs for (a count, no names). Missing in periods from before 0.4.0. */
  reviewedFor?: number;
  /** How many people reviewed this person's PRs (a count, no names). Missing in periods from before 0.4.0. */
  reviewedBy?: number;
  /** Opt-in only: the most-traded teammates, at most MAX_STORED_PARTNERS. Removed by forgetPartners. */
  partners?: Partner[];
}

/** What's recorded for a period; updatedAt is added by recordPeriod. */
export type PeriodInput = Omit<Period, 'updatedAt'>;

/** Identifies a period within a series (and a recap: see AppState.recapSeen). */
export const periodKey = (p: Pick<Period, 'from' | 'to'>) => `${p.from}|${p.to}`;
/** Shaped like a period key ("YYYY-MM-DD|YYYY-MM-DD"), for values read from disk or sent by the window. */
export const isPeriodKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * What a period records about the people reviews were traded with (`partners` is most traded first, as
 * giveAndTake returns it): always the two anonymous counts; the top logins only when `remember` is true.
 */
export function partnerExtras(partners: Partner[], remember: boolean): Pick<Period, 'reviewedFor' | 'reviewedBy' | 'partners'> {
  return {
    reviewedFor: partners.filter((p) => p.gave > 0).length,
    reviewedBy: partners.filter((p) => p.got > 0).length,
    ...(remember && partners.length > 0 ? { partners: partners.slice(0, MAX_STORED_PARTNERS) } : {}),
  };
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

function parsePartner(v: unknown): Partner | null {
  if (!isObject(v)) return null;
  const { login, gave, got } = v;
  return typeof login === 'string' && isValidLogin(login) && isCount(gave) && isCount(got) ? { login, gave, got } : null;
}

/** A period's optional extras: each one that's invalid is dropped on its own, keeping the period. */
function parseExtras(v: Record<string, unknown>): Pick<Period, 'reviewedFor' | 'reviewedBy' | 'partners'> {
  const { reviewedFor, reviewedBy, partners } = v;
  const valid = Array.isArray(partners)
    ? partners.map(parsePartner).filter((p): p is Partner => p !== null).slice(0, MAX_STORED_PARTNERS)
    : [];
  return {
    ...(isCount(reviewedFor) ? { reviewedFor } : {}),
    ...(isCount(reviewedBy) ? { reviewedBy } : {}),
    ...(valid.length > 0 ? { partners: valid } : {}),
  };
}

function parsePeriod(v: unknown): Period | null {
  if (!isObject(v)) return null;
  const { from, to, authored, reviewed, final, updatedAt } = v;
  if (typeof from !== 'string' || typeof to !== 'string' || !isValidDate(from) || !isValidDate(to) || from > to) return null;
  if (!isCount(authored) || !isCount(reviewed) || typeof final !== 'boolean' || !isTime(updatedAt)) return null;
  return { from, to, authored, reviewed, final, updatedAt, ...parseExtras(v) };
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
  const unique = [...new Map(valid.map((p) => [periodKey(p), p])).values()].sort((a, b) => a.from.localeCompare(b.from));
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
export function recordPeriod(h: History, settings: SprintSettings, p: PeriodInput, now: string): History {
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

/**
 * Every stored teammate login removed, from every series (active and archived). Used when the person
 * switches "Remember teammates in history" off. The anonymous counts stay.
 */
export function forgetPartners(h: History): History {
  if (!h.series.some((s) => s.periods.some((p) => p.partners))) return h;
  const strip = ({ partners: _dropped, ...rest }: Period): Period => rest;
  return { ...h, series: h.series.map((s) => ({ ...s, periods: s.periods.map(strip) })) };
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

/**
 * Every series and period as CSV (active series first). Every field is quoted. Teammate logins are
 * never exported, even when they're remembered: only the anonymous counts are.
 */
export function historyCsv(h: History): string {
  const quote = (v: string | number | boolean) => `"${String(v).replaceAll('"', '""')}"`;
  const rows: Array<Array<string | number | boolean>> = [
    // New columns go at the end, so anything reading the older layout by position keeps working.
    ['owner', 'login', 'range', 'range_start', 'status', 'from', 'to', 'authored', 'reviewed', 'ratio', 'final', 'reviewed_for', 'reviewed_by'],
  ];
  const ordered = [...h.series.filter(isActive), ...h.series.filter((s) => !isActive(s))];
  for (const s of ordered) {
    for (const p of s.periods) {
      const r = periodRatio(p);
      rows.push([
        s.owner, s.login, RANGE_LABELS[s.kind], s.start, isActive(s) ? 'active' : 'archived', p.from, p.to, p.authored, p.reviewed,
        r.value === null ? '' : r.display, p.final, p.reviewedFor ?? '', p.reviewedBy ?? '',
      ]);
    }
  }
  return rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
