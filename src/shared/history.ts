// Review history: one series of periods per tracked range. A series is identified by owner, login,
// range kind and start date together, because periods from different ones can't be compared. At most
// one series is active (it matches the current settings); the others are archived and read-only.
// Counts only by default: no PR titles or links are ever stored, and teammates' logins only when the person
// opts in ("Remember teammates in history"; see `partners`). Everything here is pure (no Electron, no
// files), so scripts/check.ts can test it; src/main/history.ts reads and writes the file.
import { isValidDate, type DateWindow } from './dateWindow';
import { reviewRatio, superMinReviews, type ReviewRatio } from './ratio';
import { RANGE_KINDS, RANGE_LABELS, windowDays, type RangeKind } from './range';
import type { HistoryChoice, Partner, TrackedSettings } from './types';
import { isObject, isValidLogin } from './validate';

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
  /** How many people this person reviewed PRs for (a count, no names). Optional: a missing or invalid count is dropped, keeping the period. */
  reviewedFor?: number;
  /** How many people reviewed this person's PRs (a count, no names). Optional: a missing or invalid count is dropped, keeping the period. */
  reviewedBy?: number;
  /** Opt-in only: the most-traded teammates, at most MAX_STORED_PARTNERS. Removed by forgetPartners. */
  partners?: Partner[];
}

/** What's recorded for a period; updatedAt is added by recordPeriod. */
export type PeriodInput = Omit<Period, 'updatedAt'>;

/** Identifies a period within a series (and a recap: see AppState.recapSeen). */
export const periodKey = (period: Pick<Period, 'from' | 'to'>) => `${period.from}|${period.to}`;
/** Shaped like a period key ("YYYY-MM-DD|YYYY-MM-DD"), for values read from disk or sent by the window. */
export const isPeriodKey = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * What a period records about the people reviews were traded with (`partners` is most traded first, as
 * giveAndTake returns it): always the two anonymous counts; the top logins only when `remember` is true.
 */
export function partnerExtras(partners: Partner[], remember: boolean): Pick<Period, 'reviewedFor' | 'reviewedBy' | 'partners'> {
  return {
    reviewedFor: partners.filter((partner) => partner.gave > 0).length,
    reviewedBy: partners.filter((partner) => partner.got > 0).length,
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
/** Owner and login compare case-insensitively, as GitHub treats them. */
const seriesId = (key: SeriesKey) => [key.owner.toLowerCase(), key.login.toLowerCase(), key.kind, key.start].join('|');
const keyOf = (settings: TrackedSettings): SeriesKey => ({
  owner: settings.owner,
  login: settings.login,
  kind: settings.range.kind,
  start: settings.range.start,
});
const matchesSettings = (series: SeriesKey, settings: TrackedSettings) => seriesId(series) === seriesId(keyOf(settings));

const isActive = (series: Series) => series.archivedAt === null;
const activeOf = (history: History) => history.series.find(isActive) ?? null;
const byFrom = (a: Period, b: Period) => a.from.localeCompare(b.from);

// ---------- reading a file that may have been hand-edited or corrupted ----------

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;

function parsePartner(value: unknown): Partner | null {
  if (!isObject(value)) return null;
  const { login, gave, got } = value;
  return typeof login === 'string' && isValidLogin(login) && isCount(gave) && isCount(got) ? { login, gave, got } : null;
}

/** A period's optional extras: each one that's invalid is dropped on its own, keeping the period. */
function parseExtras(value: Record<string, unknown>): Pick<Period, 'reviewedFor' | 'reviewedBy' | 'partners'> {
  const { reviewedFor, reviewedBy, partners } = value;
  const validPartners = Array.isArray(partners)
    ? partners.map(parsePartner).filter((partner): partner is Partner => partner !== null).slice(0, MAX_STORED_PARTNERS)
    : [];
  return {
    ...(isCount(reviewedFor) ? { reviewedFor } : {}),
    ...(isCount(reviewedBy) ? { reviewedBy } : {}),
    ...(validPartners.length > 0 ? { partners: validPartners } : {}),
  };
}

function parsePeriod(value: unknown): Period | null {
  if (!isObject(value)) return null;
  const { from, to, authored, reviewed, final, updatedAt } = value;
  if (typeof from !== 'string' || typeof to !== 'string' || !isValidDate(from) || !isValidDate(to) || from > to) return null;
  if (!isCount(authored) || !isCount(reviewed) || typeof final !== 'boolean' || !isTime(updatedAt)) return null;
  return { from, to, authored, reviewed, final, updatedAt, ...parseExtras(value) };
}

function parseSeries(value: unknown): Series | null {
  if (!isObject(value)) return null;
  const { owner, login, kind, start, startedAt, archivedAt, periods } = value;
  if (typeof owner !== 'string' || !isValidLogin(owner) || typeof login !== 'string' || !isValidLogin(login)) return null;
  if (typeof kind !== 'string' || !(RANGE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof start !== 'string' || !isValidDate(start) || !isTime(startedAt)) return null;
  if (archivedAt !== null && !isTime(archivedAt)) return null;
  if (!Array.isArray(periods)) return null;
  const validPeriods = periods.map(parsePeriod).filter((period): period is Period => period !== null);
  // One entry per period (the last one wins), oldest first.
  const unique = [...new Map(validPeriods.map((period) => [periodKey(period), period])).values()].sort(byFrom);
  return { owner, login, kind: kind as RangeKind, start, startedAt, archivedAt, periods: unique };
}

/** History from the file's parsed JSON. Anything invalid is dropped rather than trusted. */
export function parseHistory(raw: unknown): { history: History; readOnly: boolean } {
  if (!isObject(raw)) return { history: EMPTY_HISTORY, readOnly: false };
  // Written by a newer version (after a downgrade): don't guess at its format, and never overwrite it.
  if (typeof raw.version === 'number' && raw.version > HISTORY_VERSION) return { history: EMPTY_HISTORY, readOnly: true };
  const parsed = (Array.isArray(raw.series) ? raw.series : []).map(parseSeries).filter((series): series is Series => series !== null);
  const seenIds = new Set<string>();
  let haveActive = false;
  const series = parsed.flatMap((candidate) => {
    const id = seriesId(candidate);
    if (seenIds.has(id)) return [];
    seenIds.add(id);
    // Only one series can be active; any extra one is treated as archived.
    if (isActive(candidate)) {
      if (haveActive) return [{ ...candidate, archivedAt: candidate.startedAt }];
      haveActive = true;
    }
    return [candidate];
  });
  return { history: { version: HISTORY_VERSION, series }, readOnly: false };
}

// ---------- changes (each returns a new History; nothing is modified in place) ----------

/** When saving `settings` would retire history that has periods, what the UI should ask about. */
export function needsChoice(history: History, settings: TrackedSettings): HistoryChoice | null {
  const active = activeOf(history);
  if (!active || matchesSettings(active, settings) || active.periods.length === 0) return null;
  return { kind: active.kind, start: active.start, periods: active.periods.length };
}

/**
 * Makes `settings` the active series: the current one is archived (or deleted), and an archived series
 * with exactly these settings is resumed. A new series is only created once it has a period to hold.
 */
export function switchSeries(history: History, settings: TrackedSettings, choice: 'archive' | 'delete', now: string): History {
  const active = activeOf(history);
  let series = history.series;
  if (active && !matchesSettings(active, settings)) {
    // An empty series has nothing worth archiving, so it's dropped either way.
    series =
      choice === 'delete' || active.periods.length === 0
        ? series.filter((candidate) => candidate !== active)
        : series.map((candidate) => (candidate === active ? { ...candidate, archivedAt: now } : candidate));
  }
  if (!series.some(isActive)) {
    const match = series.find((candidate) => matchesSettings(candidate, settings));
    if (match) series = series.map((candidate) => (candidate === match ? { ...candidate, archivedAt: null } : candidate));
  }
  return series === history.series ? history : { ...history, series };
}

/** Adds or updates one period of the active series. A final period is never replaced by a non-final one. */
export function recordPeriod(history: History, settings: TrackedSettings, input: PeriodInput, now: string): History {
  const switched = switchSeries(history, settings, 'archive', now);
  const existing = activeOf(switched);
  const active: Series = existing ?? { ...keyOf(settings), startedAt: now, archivedAt: null, periods: [] };
  const isSamePeriod = (period: Period) => period.from === input.from && period.to === input.to;
  if (active.periods.find(isSamePeriod)?.final && !input.final) return switched;
  const periods = [...active.periods.filter((period) => !isSamePeriod(period)), { ...input, updatedAt: now }].sort(byFrom);
  const updated = { ...active, periods };
  const series = existing
    ? switched.series.map((candidate) => (candidate === existing ? updated : candidate))
    : [...switched.series, updated];
  return capPeriods({ ...switched, series });
}

/**
 * Every stored teammate login removed, from every series (active and archived). Used when the person
 * switches "Remember teammates in history" off. The anonymous counts stay.
 */
export function forgetPartners(history: History): History {
  if (!history.series.some((series) => series.periods.some((period) => period.partners))) return history;
  const withoutPartners = ({ partners: _dropped, ...rest }: Period): Period => rest;
  return { ...history, series: history.series.map((series) => ({ ...series, periods: series.periods.map(withoutPartners) })) };
}

/** Keeps the total under MAX_PERIODS: oldest archived periods first, then the oldest active ones. */
function capPeriods(history: History): History {
  let excess = history.series.reduce((total, series) => total + series.periods.length, 0) - MAX_PERIODS;
  if (excess <= 0) return history;
  const archivedOldestFirst = history.series
    .filter((series) => !isActive(series))
    .sort((a, b) => a.archivedAt!.localeCompare(b.archivedAt!));
  const trimmed = new Map<Series, Period[]>();
  for (const series of [...archivedOldestFirst, ...history.series.filter(isActive)]) {
    if (excess <= 0) break;
    const dropCount = Math.min(excess, series.periods.length);
    trimmed.set(series, series.periods.slice(dropCount));
    excess -= dropCount;
  }
  const series = history.series
    .map((candidate) => (trimmed.has(candidate) ? { ...candidate, periods: trimmed.get(candidate)! } : candidate))
    // An archived series left with no periods is removed; the active one always stays.
    .filter((candidate) => isActive(candidate) || candidate.periods.length > 0);
  return { ...history, series };
}

// ---------- reading ----------

/**
 * The most recent period of the active series that has ended (before `current`) but wasn't finalized:
 * it gets fetched one last time to lock in its numbers.
 */
export function pendingFinalize(history: History, settings: TrackedSettings, current: DateWindow): Period | null {
  const active = activeOf(history);
  if (!active || !matchesSettings(active, settings)) return null;
  return active.periods.filter((period) => !period.final && period.to < current.from).at(-1) ?? null;
}

/**
 * What the UI is sent: the active series only if it belongs to the current settings (none yet means
 * none shown), and every archived series, most recently archived first.
 */
export function historyView(history: History, readOnly: boolean, settings: TrackedSettings | null): HistoryView {
  const active = activeOf(history);
  return {
    active: active && settings && matchesSettings(active, settings) ? active : null,
    archived: history.series.filter((series) => !isActive(series)).sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!)),
    readOnly,
  };
}

/** A period's ratio, judged with the super minimum for its own length. */
export const periodRatio = (period: Period): ReviewRatio =>
  reviewRatio(period.reviewed, period.authored, superMinReviews(windowDays(period)));

/**
 * Every series and period as CSV (active series first). Every field is quoted. Teammate logins are
 * never exported, even when they're remembered: only the anonymous counts are.
 */
export function historyCsv(history: History): string {
  const quote = (field: string | number | boolean) => `"${String(field).replaceAll('"', '""')}"`;
  const rows: Array<Array<string | number | boolean>> = [
    // New columns go at the end, so anything reading the older layout by position keeps working.
    ['owner', 'login', 'range', 'range_start', 'status', 'from', 'to', 'authored', 'reviewed', 'ratio', 'final', 'reviewed_for', 'reviewed_by'],
  ];
  const activeFirst = [...history.series.filter(isActive), ...history.series.filter((series) => !isActive(series))];
  for (const series of activeFirst) {
    for (const period of series.periods) {
      const ratio = periodRatio(period);
      rows.push([
        series.owner, series.login, RANGE_LABELS[series.kind], series.start, isActive(series) ? 'active' : 'archived',
        period.from, period.to, period.authored, period.reviewed, ratio.value === null ? '' : ratio.display, period.final,
        period.reviewedFor ?? '', period.reviewedBy ?? '',
      ]);
    }
  }
  return rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
