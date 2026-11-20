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
export const setTransport = (t: Transport) => {
  transport = t;
};

export interface Actor {
  login: string;
  __typename: string;
}

/** Login of a PR/review author. Deleted users come back as null ("ghost"); some bots lack the [bot] suffix. */
export const actorLogin = (a: Actor | null) =>
  !a ? 'ghost' : a.__typename === 'Bot' && !a.login.endsWith('[bot]') ? `${a.login}[bot]` : a.login;
export const actorIsBot = (a: Actor | null) => !!a && (a.__typename === 'Bot' || a.login.endsWith('[bot]'));

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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError('Cancelled'));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(id), reject(new CancelledError('Cancelled'))), { once: true });
  });
const MAX_ATTEMPTS = 3;
/** When GitHub gives no reset time for a rate limit, wait at least this long before asking again. */
const MIN_RATE_LIMIT_WAIT_MS = 60_000;

function rateLimitError(res: Response): GitHubError {
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
  const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
  const retryAt = Math.max(Date.now() + MIN_RATE_LIMIT_WAIT_MS, reset, retryAfter ? Date.now() + retryAfter : 0);
  const mins = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
  return new GitHubError(`GitHub's rate limit was reached. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`, retryAt);
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
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1), signal);
    if (signal?.aborted) throw new CancelledError('Cancelled');

    let res: Response;
    try {
      res = await transport(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'reciprocity',
        },
        body: JSON.stringify({ query: doc, variables }),
        redirect: 'error', // never send the token anywhere else
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (signal?.aborted) throw new CancelledError('Cancelled');
      lastProblem = `Couldn't reach GitHub (${redact(err instanceof Error ? err.message : String(err))}).`;
      continue;
    }

    if (res.status === 401) {
      throw new GitHubError('GitHub rejected the token. It may have expired or been revoked. Use "Change token" to add a new one.');
    }
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
      throw rateLimitError(res);
    }
    if (res.status === 403) {
      throw new GitHubError(await safeMessage(res, 'GitHub refused the request (403). The token may not have access to these repositories.'));
    }
    if (res.status >= 500) {
      lastProblem = `GitHub had a problem (HTTP ${res.status}).`;
      continue;
    }
    if (!res.ok) throw new GitHubError(await safeMessage(res, `GitHub returned HTTP ${res.status}.`));

    let json: { data?: T; errors?: Array<{ type?: string; message: string }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      lastProblem = 'GitHub sent an incomplete response.';
      continue;
    }
    if (json.errors?.length) {
      if (json.errors.some((e) => e.type === 'RATE_LIMITED')) throw rateLimitError(res);
      throw new GitHubError(redact(json.errors.map((e) => e.message).join('; ')).slice(0, 500));
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
async function safeMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) return redact(body.message).slice(0, 300);
  } catch {
    // not JSON; use the fallback
  }
  return fallback;
}
