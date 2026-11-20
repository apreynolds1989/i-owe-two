// The counting rules and search-query building, kept free of network and Electron code so
// scripts/check.ts can test them.
import type { SprintWindow } from '../shared/args';
import { shiftDay } from '../shared/range';
import { isValidLogin } from '../shared/validate';
import { actorIsBot, actorLogin, type Actor } from './github';

export { shiftDay };

export interface ReviewNode {
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt: string | null;
  author: Actor | null;
}

/** Converts an ISO instant to its YYYY-MM-DD date in a timezone. */
export type ToLocalDate = (iso: string) => string;

export function makeLocalDate(timeZone: string): ToLocalDate {
  // en-CA formats as YYYY-MM-DD, so results compare correctly as strings.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => fmt.format(new Date(iso));
}

export const inWindow = (day: string, w: SprintWindow) => day >= w.from && day <= w.to;

/** A review that was actually submitted. PENDING is an unsent draft and only visible to its author anyway. */
const submitted = (r: ReviewNode) => r.state !== 'PENDING' && !!r.submittedAt;

/** True if `login` submitted any review (any state) whose local date falls in the window. */
export function reviewedInWindow(login: string, reviews: ReviewNode[], w: SprintWindow, toLocal: ToLocalDate): boolean {
  const me = login.toLowerCase();
  return reviews.some((r) => submitted(r) && actorLogin(r.author).toLowerCase() === me && inWindow(toLocal(r.submittedAt!), w));
}

/** Distinct humans other than the author who submitted a review in any state. */
export function humanReviewers(author: string, reviews: ReviewNode[]): string[] {
  const logins = reviews
    .filter((r) => submitted(r) && !actorIsBot(r.author))
    .map((r) => actorLogin(r.author).toLowerCase())
    .filter((login) => login !== author.toLowerCase());
  return [...new Set(logins)];
}

/** PRs carrying an ignored label (compared case-insensitively) aren't waiting on reviewers. */
export const hasIgnoredLabel = (labels: string[], ignore: string[]) => labels.some((l) => ignore.includes(l.toLowerCase()));

export const REVIEWERS_NEEDED = 2;

export interface SearchQueries {
  authored: string;
  reviewed: string;
  open: string;
  waiting: string;
}

/**
 * The four search strings. Every piece is validated first: owner and login can only contain
 * letters, digits and hyphens, and dates are strict YYYY-MM-DD, so nothing typed into the app can
 * add qualifiers or widen what is searched. Throws on anything invalid (the UI validates earlier).
 */
export function buildSearchQueries(ownerType: 'User' | 'Organization', owner: string, login: string, w: SprintWindow): SearchQueries {
  if (!isValidLogin(owner) || !isValidLogin(login)) throw new Error('Invalid owner or login.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.from) || !/^\d{4}-\d{2}-\d{2}$/.test(w.to)) throw new Error('Invalid dates.');
  const scope = `${ownerType === 'Organization' ? 'org' : 'user'}:${owner}`;
  // GitHub's search dates are UTC days: widen by one day each side, then filter exactly on local dates.
  return {
    authored: `${scope} is:pr author:${login} created:${shiftDay(w.from, -1)}..${shiftDay(w.to, 1)}`,
    // Submitting a review bumps updatedAt, so every PR reviewed in the window was updated on or after its start.
    reviewed: `${scope} is:pr reviewed-by:${login} -author:${login} updated:>=${shiftDay(w.from, -1)}`,
    open: `${scope} is:pr is:open draft:false`,
    // Only pending requests: GitHub removes a review request once that person reviews.
    waiting: `${scope} is:pr is:open draft:false review-requested:${login}`,
  };
}
