// The only code that talks to GitHub. Runs in the main process, where the token lives.
// Read-only by construction: it can only send the fixed query documents below (no mutations), only to
// GitHub's GraphQL endpoint, and it never follows redirects (so the token can't be forwarded elsewhere).
// The network call itself is injected (see transport.ts) so this file has no Electron dependency and
// scripts/check.ts can test it under plain Node.
import { redact } from '../shared/validate';

export const ENDPOINT = 'https://api.github.com/graphql';

/** Sends one HTTPS request. Provided by transport.ts (Chromium's network stack and the OS certificate store). */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
let transport: Transport | null = null;
/** Installs the network call (transport.ts in the app, a fake in scripts/check.ts). */
export const setTransport = (next: Transport) => {
  transport = next;
};

export interface Actor {
  login: string;
  __typename: string;
}

/** Login of a PR/review author. Deleted users come back as null ("ghost"); some bots lack the [bot] suffix. */
export const actorLogin = (actor: Actor | null) =>
  !actor ? 'ghost' : actor.__typename === 'Bot' && !actor.login.endsWith('[bot]') ? `${actor.login}[bot]` : actor.login;
/** A bot account, whether GitHub types it as one or it only carries the [bot] suffix. */
export const actorIsBot = (actor: Actor | null) => !!actor && (actor.__typename === 'Bot' || actor.login.endsWith('[bot]'));

/** Every query this app can send. Person-supplied values only ever travel as variables. */
export const QUERIES = Object.freeze({
  viewer: /* GraphQL */ `query Viewer { viewer { login } }`,
  owner: /* GraphQL */ `query Owner($login: String!) { repositoryOwner(login: $login) { __typename login } }`,
  // reviews(last: 100) is far above any real PR's review count, and on a PR with more it keeps the most
  // recent ones, which is what someone's standing review depends on. labels(first: 20) likewise.
  search: /* GraphQL */ `query Search($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          url
          createdAt
          repository { nameWithOwner }
          author { login __typename }
          labels(first: 20) { nodes { name } }
          reviews(last: 100) { nodes { state submittedAt author { login __typename } } }
        }
      }
    }
  }`,
});
const ALLOWED = new Set<string>(Object.values(QUERIES));

/** Refuses anything that isn't one of the fixed read-only queries. Exported so the check script can test it. */
export function assertReadOnlyQuery(doc: string): void {
  if (!ALLOWED.has(doc)) throw new Error('Refused to send a GraphQL document that is not on the allowlist.');
  if (!/^\s*query\b/.test(doc) || /\b(mutation|subscription)\b/i.test(doc)) {
    throw new Error('Refused to send a GraphQL document that is not a read-only query.');
  }
}

/** A failure with a message that is safe to show (already redacted, never contains the token). */
export class GitHubError extends Error {
  /** For rate limits: the earliest time (epoch ms) it's polite to ask GitHub again. */
  retryAt?: number;
  constructor(message: string, retryAt?: number) {
    super(message);
    this.retryAt = retryAt;
  }
}

/** Thrown when a refresh was cancelled (token removed, new settings): not an error to show. */
export class CancelledError extends Error {}
const cancelled = () => new CancelledError('Cancelled');

/** Waits `ms`, or rejects with CancelledError as soon as `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(cancelled())), { once: true });
  });

const MAX_ATTEMPTS = 3;
/** Retries wait 1 s, then 2 s (doubling each time). */
const FIRST_RETRY_DELAY_MS = 1000;
/** One request that takes longer than this is abandoned (and retried like any network failure). */
const REQUEST_TIMEOUT_MS = 30_000;
/** When GitHub gives no reset time for a rate limit, wait at least this long before asking again. */
const MIN_RATE_LIMIT_WAIT_MS = 60_000;

/** "GitHub's rate limit was reached. Try again in about N minutes." for a retry time (epoch ms). */
export function rateLimitMessage(retryAt: number): string {
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
  return `GitHub's rate limit was reached. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** A rate-limit error that waits for the latest of GitHub's reset time, its Retry-After, or a minute. */
function rateLimitError(response: Response): GitHubError {
  const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000;
  const retryAfterMs = Number(response.headers.get('retry-after') ?? 0) * 1000;
  const retryAt = Math.max(Date.now() + MIN_RATE_LIMIT_WAIT_MS, resetAt, retryAfterMs ? Date.now() + retryAfterMs : 0);
  return new GitHubError(rateLimitMessage(retryAt), retryAt);
}

/**
 * Send one allowlisted query. Retries brief network or server hiccups (up to 3 attempts), but fails
 * fast with a clear message on auth problems and rate limits instead of hammering the API.
 */
export async function graphql<T>(
  token: string,
  doc: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  assertReadOnlyQuery(doc);
  if (!transport) throw new Error('No network transport configured.');
  let lastProblem = 'GitHub could not be reached.';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), signal);
    if (signal?.aborted) throw cancelled();

    let response: Response;
    try {
      response = await transport(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'i-owe-two',
        },
        body: JSON.stringify({ query: doc, variables }),
        redirect: 'error', // never send the token anywhere else
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      lastProblem = `Couldn't reach GitHub (${redact(err instanceof Error ? err.message : String(err))}).`;
      continue;
    }

    if (response.status === 401) {
      throw new GitHubError('GitHub rejected the token. It may have expired or been revoked. Use "Change token" to add a new one.');
    }
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      throw rateLimitError(response);
    }
    if (response.status === 403) {
      throw new GitHubError(await safeMessage(response, 'GitHub refused the request (403). The token may not have access to these repositories.'));
    }
    if (response.status >= 500) {
      lastProblem = `GitHub had a problem (HTTP ${response.status}).`;
      continue;
    }
    if (!response.ok) throw new GitHubError(await safeMessage(response, `GitHub returned HTTP ${response.status}.`));

    let json: { data?: T; errors?: Array<{ type?: string; message: string }> };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      lastProblem = 'GitHub sent an incomplete response.';
      continue;
    }
    if (json.errors?.length) {
      if (json.errors.some((error) => error.type === 'RATE_LIMITED')) throw rateLimitError(response);
      throw new GitHubError(redact(json.errors.map((error) => error.message).join('; ')).slice(0, 500));
    }
    if (!json.data) {
      lastProblem = 'GitHub sent an empty response.';
      continue;
    }
    return json.data;
  }
  throw new GitHubError(lastProblem);
}

/** GitHub's own error message if it sent one (redacted and length-limited), else the fallback. */
async function safeMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) return redact(body.message).slice(0, 300);
  } catch {
    // not JSON; use the fallback
  }
  return fallback;
}
