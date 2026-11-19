// Validates the sprint window: two inclusive YYYY-MM-DD dates.

export interface SprintWindow {
  from: string;
  to: string;
}

/** Longest window accepted. Keeps searches (and GitHub API use) proportionate to a sprint. */
export const MAX_WINDOW_DAYS = 92;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Returns the window, or a message saying what's wrong with it. */
export function parseWindow(from: string, to: string): SprintWindow | { error: string } {
  if (!from || !to) return { error: 'Choose a start and an end date.' };
  for (const d of [from, to]) if (!isValidDate(d)) return { error: `Not a valid date: ${d}` };
  // YYYY-MM-DD strings compare correctly as text.
  if (from > to) return { error: 'The start date is after the end date.' };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_WINDOW_DAYS) return { error: `Pick a window of ${MAX_WINDOW_DAYS} days or less.` };
  return { from, to };
}
