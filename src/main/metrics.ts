// Fetches the numbers from GitHub for the chosen owner, person and dates.
import type { SprintWindow } from '../shared/args';
import type { Metric, PrSummary, SprintMetrics, SprintSettings } from '../shared/types';
import { actorIsBot, actorLogin, CancelledError, GitHubError, graphql, QUERIES, type Actor } from './github';
import {
  buildSearchQueries, hasIgnoredLabel, humanReviewers, inWindow, makeLocalDate, REVIEWERS_NEEDED,
  reviewedInWindow, type ReviewNode, type SearchQueries,
} from './rules';

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

/** GitHub search never returns more than 1,000 results for one query (20 pages of 50). */
const MAX_PAGES = 20;
/** Pause between search requests, to stay well clear of GitHub's secondary rate limits. */
const REQUEST_GAP_MS = 300;

export const pause = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError('Cancelled'));
    const id = setTimeout(resolve, REQUEST_GAP_MS);
    signal?.addEventListener('abort', () => (clearTimeout(id), reject(new CancelledError('Cancelled'))), { once: true });
  });

/** Every PR matching `q`, up to GitHub's 1,000-result cap. Pages are fetched one at a time. */
async function searchPrs(token: string, q: string, signal?: AbortSignal): Promise<{ nodes: PrNode[]; total: number }> {
  const nodes: PrNode[] = [];
  let after: string | null = null;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await pause(signal);
    const data: SearchResponse = await graphql<SearchResponse>(token, QUERIES.search, { q, after }, signal);
    total = data.search.issueCount;
    for (const n of data.search.nodes) if (n && 'number' in n) nodes.push(n as PrNode);
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { nodes, total };
}

export async function getViewerLogin(token: string): Promise<string> {
  return (await graphql<{ viewer: { login: string } }>(token, QUERIES.viewer)).viewer.login;
}

/** Whether `login` is a user or an organization (decides between user: and org: searches). */
export async function getOwnerType(token: string, login: string, signal?: AbortSignal): Promise<'User' | 'Organization'> {
  const data = await graphql<{ repositoryOwner: { __typename: string } | null }>(token, QUERIES.owner, { login }, signal);
  const type = data.repositoryOwner?.__typename;
  if (type === 'User' || type === 'Organization') return type;
  throw new GitHubError(`There's no GitHub user or organization called "${login}".`);
}

const summary = (n: PrNode, extra: Partial<PrSummary> = {}): PrSummary => ({
  repo: n.repository.nameWithOwner,
  number: n.number,
  title: n.title,
  url: n.url,
  author: actorLogin(n.author),
  createdAt: n.createdAt,
  ...extra,
});

const metric = (prs: PrSummary[], search: { total: number }): Metric => ({
  count: prs.length,
  prs,
  capped: search.total > MAX_PAGES * 50,
  searchTotal: search.total,
});

const newestFirst = (a: PrNode, b: PrNode) => b.createdAt.localeCompare(a.createdAt);
const oldestFirst = (a: PrNode, b: PrNode) => a.createdAt.localeCompare(b.createdAt);

/** Open PRs with their distinct human reviewers counted, longest-waiting first. */
const withReviewers = (nodes: PrNode[]) =>
  [...nodes].sort(oldestFirst).map((n) => ({ n, reviewers: humanReviewers(actorLogin(n.author), n.reviews.nodes).length }));

/** The two searches the ratio needs: PRs authored and PRs reviewed in the window. */
async function authoredAndReviewed(token: string, settings: SprintSettings, w: SprintWindow, q: SearchQueries, timezone: string, signal?: AbortSignal) {
  const toLocal = makeLocalDate(timezone);
  const authoredRaw = await searchPrs(token, q.authored, signal);
  await pause(signal);
  const reviewedRaw = await searchPrs(token, q.reviewed, signal);
  const authored = authoredRaw.nodes.filter((n) => inWindow(toLocal(n.createdAt), w)).sort(newestFirst);
  const reviewed = reviewedRaw.nodes.filter((n) => reviewedInWindow(settings.login, n.reviews.nodes, w, toLocal)).sort(newestFirst);
  return { authored, authoredRaw, reviewed, reviewedRaw };
}

/** Just the two counts, for locking in a period that has ended (two searches instead of four). */
export async function getPeriodCounts(
  token: string,
  settings: SprintSettings,
  w: SprintWindow,
  ownerType: 'User' | 'Organization',
  timezone: string,
  signal?: AbortSignal,
): Promise<{ authored: number; reviewed: number }> {
  const q = buildSearchQueries(ownerType, settings.owner, settings.login, w);
  const r = await authoredAndReviewed(token, settings, w, q, timezone, signal);
  return { authored: r.authored.length, reviewed: r.reviewed.length };
}

export async function getSprintMetrics(
  token: string,
  settings: SprintSettings,
  w: SprintWindow,
  ownerType: 'User' | 'Organization',
  timezone: string,
  signal?: AbortSignal,
): Promise<SprintMetrics> {
  const q = buildSearchQueries(ownerType, settings.owner, settings.login, w);

  // One search at a time, with a short pause between requests: gentle on GitHub's rate limits.
  const r = await authoredAndReviewed(token, settings, w, q, timezone, signal);
  await pause(signal);
  const openRaw = await searchPrs(token, q.open, signal);
  await pause(signal);
  const waitingRaw = await searchPrs(token, q.waiting, signal);

  const needsReviewers = withReviewers(
    openRaw.nodes
      .filter((n) => !actorIsBot(n.author))
      .filter((n) => !hasIgnoredLabel(n.labels.nodes.map((l) => l.name), settings.ignoreLabels)),
  )
    .filter(({ reviewers }) => reviewers < REVIEWERS_NEEDED)
    .map(({ n, reviewers }) => summary(n, { reviewerCount: reviewers, labels: n.labels.nodes.map((l) => l.name) }));

  const waitingOnYou = withReviewers(waitingRaw.nodes).map(({ n, reviewers }) => summary(n, { reviewerCount: reviewers }));

  return {
    settings,
    window: w,
    ownerType,
    timezone,
    fetchedAt: new Date().toISOString(),
    authored: metric(r.authored.map((n) => summary(n)), r.authoredRaw),
    reviewed: metric(r.reviewed.map((n) => summary(n)), r.reviewedRaw),
    needsReviewers: metric(needsReviewers, openRaw),
    waitingOnYou: metric(waitingOnYou, waitingRaw),
  };
}
