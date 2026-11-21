// The counting rules and search-query building, kept free of network and Electron code so
// scripts/check.ts can test them.
import type { DateWindow } from '../shared/dateWindow';
import { shiftDay } from '../shared/range';
import { REVIEWERS_NEEDED } from '../shared/ratio';
import type { MyReview, OwnerType, Partner } from '../shared/types';
import { isValidLogin } from '../shared/validate';
import { actorIsBot, actorLogin, type Actor } from './github';

export interface ReviewNode {
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt: string | null;
  author: Actor | null;
}

/** The label part of a PR as the search query returns it. */
interface Labelled {
  labels: { nodes: Array<{ name: string }> };
}

/** Converts an ISO instant to its YYYY-MM-DD date in a timezone. */
export type ToLocalDate = (iso: string) => string;

/** A ToLocalDate for `timeZone`. The formatter is built once and reused for every conversion. */
export function makeLocalDate(timeZone: string): ToLocalDate {
  // en-CA formats as YYYY-MM-DD, so results compare correctly as strings.
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => formatter.format(new Date(iso));
}

/** True if the YYYY-MM-DD `day` is within the inclusive window. */
export const inWindow = (day: string, window: DateWindow) => day >= window.from && day <= window.to;

/** A PR's label names, as written on GitHub. */
export const labelNames = (pr: Labelled) => pr.labels.nodes.map((label) => label.name);

/** A review that was actually submitted. PENDING is an unsent draft and only visible to its author anyway. */
const submitted = (review: ReviewNode) => review.state !== 'PENDING' && !!review.submittedAt;

/** A submitted review by `login` (compared case-insensitively). */
const submittedBy = (login: string) => {
  const wanted = login.toLowerCase();
  return (review: ReviewNode) => submitted(review) && actorLogin(review.author).toLowerCase() === wanted;
};

/** True if `login` submitted any review (any state) whose local date falls in the window. */
export function reviewedInWindow(login: string, reviews: ReviewNode[], window: DateWindow, toLocal: ToLocalDate): boolean {
  const isMine = submittedBy(login);
  return reviews.some((review) => isMine(review) && inWindow(toLocal(review.submittedAt!), window));
}

/** Distinct humans other than the author who submitted a review in any state. */
export function humanReviewers(author: string, reviews: ReviewNode[]): string[] {
  const logins = reviews
    .filter((review) => submitted(review) && !actorIsBot(review.author))
    .map((review) => actorLogin(review.author).toLowerCase())
    .filter((login) => login !== author.toLowerCase());
  return [...new Set(logins)];
}

/**
 * This person's standing review on a PR, the way GitHub shows it in the reviewers list: the latest
 * approval, change request or dismissal wins, and a later plain comment doesn't undo it. Only comments
 * means 'commented'; no submitted review at all means null.
 *
 * GitHub turns a review's state into DISMISSED when it's dismissed (by a maintainer, or automatically
 * when new commits make an approval stale), so 'dismissed' can be a dismissed approval or change request.
 */
export function myReviewState(login: string, reviews: ReviewNode[]): MyReview | null {
  const mine = reviews.filter(submittedBy(login)).sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!));
  if (mine.length === 0) return null;
  const standing = mine
    .filter((review) => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED')
    .at(-1);
  if (!standing) return 'commented';
  return standing.state === 'APPROVED' ? 'approved' : standing.state === 'CHANGES_REQUESTED' ? 'changes_requested' : 'dismissed';
}

/** True if this person has submitted any review on the PR (any state). Such PRs leave "Need reviewers". */
export const hasReviewed = (login: string, reviews: ReviewNode[]) => myReviewState(login, reviews) !== null;

/**
 * The two "Waiting on you" sections. Requested (review requested from you or your team, still pending)
 * always wins, so a PR is never in both. Involved is what's left of the PRs you've reviewed, minus
 * those you've approved: an approval takes a PR off your plate until someone re-requests you.
 */
export function splitWaiting<T extends { url: string; reviews: { nodes: ReviewNode[] } }>(
  requested: T[],
  reviewed: T[],
  login: string,
): { requested: T[]; involved: T[] } {
  const requestedUrls = new Set(requested.map((pr) => pr.url));
  const involved = reviewed.filter((pr) => {
    if (requestedUrls.has(pr.url)) return false;
    const state = myReviewState(login, pr.reviews.nodes);
    return state !== null && state !== 'approved';
  });
  return { requested, involved };
}

/** PRs carrying an ignored label (compared case-insensitively) aren't waiting on reviewers. */
export const hasIgnoredLabel = (labels: string[], ignore: string[]) => labels.some((label) => ignore.includes(label.toLowerCase()));

/**
 * This person's own open PRs that still need reviewers: fewer than REVIEWERS_NEEDED distinct humans
 * have reviewed, and no ignored label (the same "doesn't need reviewers" meaning as for Need reviewers).
 */
export function needingReviewers<T extends Labelled & { author: Actor | null; reviews: { nodes: ReviewNode[] } }>(
  prs: T[],
  ignoreLabels: string[],
): T[] {
  return prs.filter(
    (pr) =>
      !hasIgnoredLabel(labelNames(pr), ignoreLabels) &&
      humanReviewers(actorLogin(pr.author), pr.reviews.nodes).length < REVIEWERS_NEEDED,
  );
}

/**
 * Reviews traded with each person, from the two lists the ratio is built from:
 * - gave: PRs by them that `login` reviewed in the dates (the Reviewed list, by author);
 * - got: `login`'s PRs opened in the dates (the Authored list) that they reviewed, whenever they did.
 * That mirrors the ratio itself (authored by opening date, reviewed by review date), so it needs no
 * extra searches. Bots, deleted accounts ("ghost") and `login` itself are left out. Each PR counts once
 * per person. Most traded first, then by login.
 */
export function giveAndTake(
  login: string,
  reviewed: Array<{ author: Actor | null }>,
  authored: Array<{ reviews: { nodes: ReviewNode[] } }>,
): Partner[] {
  const myLogin = login.toLowerCase();
  // Keyed by lower-cased login; the first spelling seen is the one shown.
  const tally = new Map<string, Partner>();
  const count = (partnerLogin: string, field: 'gave' | 'got') => {
    const key = partnerLogin.toLowerCase();
    const entry = tally.get(key) ?? { login: partnerLogin, gave: 0, got: 0 };
    tally.set(key, { ...entry, [field]: entry[field] + 1 });
  };
  for (const pr of reviewed) {
    if (!pr.author || actorIsBot(pr.author) || pr.author.login.toLowerCase() === myLogin) continue;
    count(pr.author.login, 'gave');
  }
  for (const pr of authored) {
    // humanReviewers already skips bots, unsent reviews and the author (`login`), but returns lower-cased
    // logins and "ghost" for deleted accounts, which have no one to credit.
    const spelling = new Map(
      pr.reviews.nodes.filter((review) => review.author).map((review) => [review.author!.login.toLowerCase(), review.author!.login]),
    );
    for (const reviewer of humanReviewers(login, pr.reviews.nodes)) {
      if (reviewer !== 'ghost') count(spelling.get(reviewer) ?? reviewer, 'got');
    }
  }
  return [...tally.values()].sort((a, b) => b.gave + b.got - (a.gave + a.got) || a.login.localeCompare(b.login));
}

/** The six search strings for one refresh (see buildSearchQueries). */
export interface SearchQueries {
  authored: string;
  reviewed: string;
  open: string;
  waiting: string;
  involved: string;
  mine: string;
}

/**
 * The six search strings. Every piece is validated first: owner and login can only contain
 * letters, digits and hyphens, and dates are strict YYYY-MM-DD, so nothing typed into the app can
 * add qualifiers or widen what is searched. Throws on anything invalid (the UI validates earlier).
 */
export function buildSearchQueries(ownerType: OwnerType, owner: string, login: string, window: DateWindow): SearchQueries {
  if (!isValidLogin(owner) || !isValidLogin(login)) throw new Error('Invalid owner or login.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.from) || !/^\d{4}-\d{2}-\d{2}$/.test(window.to)) throw new Error('Invalid dates.');
  const scope = `${ownerType === 'Organization' ? 'org' : 'user'}:${owner}`;
  // GitHub's search dates are UTC days: widen by one day each side, then filter exactly on local dates.
  return {
    authored: `${scope} is:pr author:${login} created:${shiftDay(window.from, -1)}..${shiftDay(window.to, 1)}`,
    // Submitting a review bumps updatedAt, so every PR reviewed in the window was updated on or after its start.
    reviewed: `${scope} is:pr reviewed-by:${login} -author:${login} updated:>=${shiftDay(window.from, -1)}`,
    open: `${scope} is:pr is:open draft:false`,
    // Only pending requests: GitHub removes a review request once that person reviews.
    waiting: `${scope} is:pr is:open draft:false review-requested:${login}`,
    // Open PRs this person has reviewed (any state); approved ones are dropped afterwards (splitWaiting).
    involved: `${scope} is:pr is:open draft:false reviewed-by:${login} -author:${login}`,
    // This person's own open, ready PRs; those that still need reviewers are picked out afterwards (needingReviewers).
    mine: `${scope} is:pr is:open draft:false author:${login}`,
  };
}
