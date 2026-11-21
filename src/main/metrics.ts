// Fetches the numbers from GitHub for the chosen owner, person and dates.
import type { DateWindow } from '../shared/dateWindow';
import { REVIEWERS_NEEDED } from '../shared/ratio';
import type { Metric, OwnerType, Partner, PrSummary, ReviewMetrics, TrackedSettings } from '../shared/types';
import { actorIsBot, actorLogin, GitHubError, graphql, QUERIES, sleep, type Actor } from './github';
import {
  buildSearchQueries, giveAndTake, hasIgnoredLabel, hasReviewed, humanReviewers, inWindow, labelNames, makeLocalDate, myReviewState,
  needingReviewers, reviewedInWindow, splitWaiting, type ReviewNode, type SearchQueries,
} from './rules';

/** A pull request as QUERIES.search returns it. */
interface PrNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  repository: { nameWithOwner: string };
  author: Actor | null;
  labels: { nodes: Array<{ name: string }> };
  reviews: { nodes: ReviewNode[] };
}
interface SearchResponse {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    // Search results can include nulls (e.g. items the token can't see) and non-PR items.
    nodes: Array<PrNode | Record<string, never> | null>;
  };
}
/** The PRs one search found, and GitHub's total for it (which can exceed what can be paged through). */
interface SearchResult {
  nodes: PrNode[];
  total: number;
}

/** Matches `first: 50` in QUERIES.search. */
const RESULTS_PER_PAGE = 50;
/** GitHub search never returns more than 1,000 results for one query (20 pages of 50). */
const MAX_PAGES = 20;
/** Pause between search requests, to stay well clear of GitHub's secondary rate limits. */
const REQUEST_GAP_MS = 300;

/** The polite gap between two requests. Rejects with CancelledError if the refresh is cancelled. */
export const pause = (signal?: AbortSignal) => sleep(REQUEST_GAP_MS, signal);

/** Every PR matching `query`, up to GitHub's 1,000-result cap. Pages are fetched one at a time. */
async function searchPrs(token: string, query: string, signal?: AbortSignal): Promise<SearchResult> {
  const nodes: PrNode[] = [];
  let after: string | null = null;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await pause(signal);
    const data: SearchResponse = await graphql<SearchResponse>(token, QUERIES.search, { q: query, after }, signal);
    total = data.search.issueCount;
    for (const node of data.search.nodes) if (node && 'number' in node) nodes.push(node as PrNode);
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { nodes, total };
}

/** The login of the token's owner. Also proves the token works. */
export async function getViewerLogin(token: string): Promise<string> {
  return (await graphql<{ viewer: { login: string } }>(token, QUERIES.viewer)).viewer.login;
}

/** Whether `login` is a user or an organization (decides between user: and org: searches). */
export async function getOwnerType(token: string, login: string, signal?: AbortSignal): Promise<OwnerType> {
  const data = await graphql<{ repositoryOwner: { __typename: string } | null }>(token, QUERIES.owner, { login }, signal);
  const type = data.repositoryOwner?.__typename;
  if (type === 'User' || type === 'Organization') return type;
  throw new GitHubError(`There's no GitHub user or organization called "${login}".`);
}

const toPrSummary = (pr: PrNode, extra: Partial<PrSummary> = {}): PrSummary => ({
  repo: pr.repository.nameWithOwner,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  author: actorLogin(pr.author),
  createdAt: pr.createdAt,
  ...extra,
});

/** A list built from one or more searches: capped if any of them hit GitHub's 1,000-result limit. */
const toMetric = (prs: PrSummary[], ...searches: SearchResult[]): Metric => ({
  count: prs.length,
  prs,
  capped: searches.some((search) => search.total > MAX_PAGES * RESULTS_PER_PAGE),
  searchTotal: searches.reduce((sum, search) => sum + search.total, 0),
});

const newestFirst = (a: PrNode, b: PrNode) => b.createdAt.localeCompare(a.createdAt);
const oldestFirst = (a: PrNode, b: PrNode) => a.createdAt.localeCompare(b.createdAt);

/** Open PRs with their distinct human reviewers counted, longest-waiting first. */
const withReviewerCounts = (prs: PrNode[]) =>
  [...prs].sort(oldestFirst).map((pr) => ({ pr, reviewerCount: humanReviewers(actorLogin(pr.author), pr.reviews.nodes).length }));

/** The two searches the ratio needs: PRs authored and PRs reviewed in the window. */
async function authoredAndReviewed(
  token: string,
  settings: TrackedSettings,
  window: DateWindow,
  queries: SearchQueries,
  timezone: string,
  signal?: AbortSignal,
) {
  const toLocal = makeLocalDate(timezone);
  const authoredSearch = await searchPrs(token, queries.authored, signal);
  await pause(signal);
  const reviewedSearch = await searchPrs(token, queries.reviewed, signal);
  // The searches are a day wider than the window (UTC vs local dates): keep only what's really inside it.
  const authored = authoredSearch.nodes.filter((pr) => inWindow(toLocal(pr.createdAt), window)).sort(newestFirst);
  const reviewed = reviewedSearch.nodes
    .filter((pr) => reviewedInWindow(settings.login, pr.reviews.nodes, window, toLocal))
    .sort(newestFirst);
  return { authored, authoredSearch, reviewed, reviewedSearch };
}

/** Just the counts and partners, for locking in a period that has ended (two searches instead of six). */
export async function getPeriodCounts(
  token: string,
  settings: TrackedSettings,
  window: DateWindow,
  ownerType: OwnerType,
  timezone: string,
  signal?: AbortSignal,
): Promise<{ authored: number; reviewed: number; partners: Partner[] }> {
  const queries = buildSearchQueries(ownerType, settings.owner, settings.login, window);
  const counted = await authoredAndReviewed(token, settings, window, queries, timezone, signal);
  return {
    authored: counted.authored.length,
    reviewed: counted.reviewed.length,
    partners: giveAndTake(settings.login, counted.reviewed, counted.authored),
  };
}

/** Every number and list on the panel for these settings and dates (six searches, one at a time). */
export async function getMetrics(
  token: string,
  settings: TrackedSettings,
  window: DateWindow,
  ownerType: OwnerType,
  timezone: string,
  signal?: AbortSignal,
): Promise<ReviewMetrics> {
  const queries = buildSearchQueries(ownerType, settings.owner, settings.login, window);

  // One search at a time, with a short pause between requests: gentle on GitHub's rate limits.
  const counted = await authoredAndReviewed(token, settings, window, queries, timezone, signal);
  await pause(signal);
  const openSearch = await searchPrs(token, queries.open, signal);
  await pause(signal);
  const requestedSearch = await searchPrs(token, queries.waiting, signal);
  await pause(signal);
  const involvedSearch = await searchPrs(token, queries.involved, signal);
  await pause(signal);
  const mineSearch = await searchPrs(token, queries.mine, signal);

  // A PR this person has already reviewed (any state) is no longer one they could pick up: it's either
  // done (approved) or under "Waiting on you". PRs merely requested from them stay here as well.
  const needsReviewers = withReviewerCounts(
    openSearch.nodes
      .filter((pr) => !actorIsBot(pr.author))
      .filter((pr) => !hasIgnoredLabel(labelNames(pr), settings.ignoreLabels))
      .filter((pr) => !hasReviewed(settings.login, pr.reviews.nodes)),
  )
    .filter(({ reviewerCount }) => reviewerCount < REVIEWERS_NEEDED)
    .map(({ pr, reviewerCount }) => toPrSummary(pr, { reviewerCount, labels: labelNames(pr) }));

  const split = splitWaiting(requestedSearch.nodes, involvedSearch.nodes, settings.login);
  const waitingSection = (prs: PrNode[], section: 'requested' | 'involved') =>
    withReviewerCounts(prs).map(({ pr, reviewerCount }) =>
      toPrSummary(pr, { reviewerCount, section, myReview: myReviewState(settings.login, pr.reviews.nodes) ?? undefined }),
    );
  const waitingOnYou = [...waitingSection(split.requested, 'requested'), ...waitingSection(split.involved, 'involved')];
  const yourPrsWaiting = withReviewerCounts(needingReviewers(mineSearch.nodes, settings.ignoreLabels)).map(({ pr, reviewerCount }) =>
    toPrSummary(pr, { reviewerCount }),
  );

  return {
    settings,
    window,
    ownerType,
    timezone,
    fetchedAt: new Date().toISOString(),
    authored: toMetric(counted.authored.map((pr) => toPrSummary(pr)), counted.authoredSearch),
    reviewed: toMetric(counted.reviewed.map((pr) => toPrSummary(pr)), counted.reviewedSearch),
    needsReviewers: toMetric(needsReviewers, openSearch),
    waitingOnYou: toMetric(waitingOnYou, requestedSearch, involvedSearch),
    yourPrsWaiting: toMetric(yourPrsWaiting, mineSearch),
    partners: giveAndTake(settings.login, counted.reviewed, counted.authored),
  };
}
