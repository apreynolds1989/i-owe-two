// Date formatting for the UI. YYYY-MM-DD strings are read as UTC so a date never shifts by a day.

/** Today's date on this computer, as YYYY-MM-DD. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const month = (s: string) => asDate(s).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
const day = (s: string) => asDate(s).getUTCDate();
const year = (s: string) => s.slice(0, 4);

/**
 * "Nov 9 – 21", "Nov 28 – Dec 5", "Nov 20" for a single day. Years are added when the range spans two
 * years ("Dec 28, 2026 – Jan 3, 2027") or isn't in the current one ("Nov 9 – 21, 2025").
 */
export function shortRange(from: string, to: string): string {
  if (year(from) !== year(to)) return `${month(from)} ${day(from)}, ${year(from)} – ${month(to)} ${day(to)}, ${year(to)}`;
  const suffix = year(from) === localToday().slice(0, 4) ? '' : `, ${year(from)}`;
  if (from === to) return `${month(from)} ${day(from)}${suffix}`;
  const end = month(from) === month(to) ? `${day(to)}` : `${month(to)} ${day(to)}`;
  return `${month(from)} ${day(from)} – ${end}${suffix}`;
}

/** "opened today", "opened 4d ago", "opened 3w ago", "opened 2mo ago". */
export function openedAgo(iso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
  if (days === 0) return 'opened today';
  if (days === 1) return 'opened yesterday';
  if (days < 14) return `opened ${days}d ago`;
  if (days < 60) return `opened ${Math.floor(days / 7)}w ago`;
  return `opened ${Math.floor(days / 30)}mo ago`;
}
