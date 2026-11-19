// Input validation shared by the UI (for instant hints) and the main process (which enforces it and
// never trusts the UI). Everything a person types is checked here before it can reach GitHub.

/**
 * GitHub's rule for user and organization names: letters, digits and single hyphens, not starting
 * with a hyphen; underscores too, for Enterprise Managed User names like "alice_acme". Because no
 * spaces, colons or quotes are allowed, a name can never smuggle extra search qualifiers (like
 * "alice repo:someone/private") into a query.
 */
export const MAX_LOGIN_LENGTH = 50;
const LOGIN_RE = new RegExp(`^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9])){0,${MAX_LOGIN_LENGTH - 1}}$`);
export const isValidLogin = (s: string) => LOGIN_RE.test(s);

/** Fine-grained personal access tokens. Classic tokens (ghp_…) have broad scopes, so they're refused. */
const FINE_GRAINED_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const OTHER_GITHUB_TOKEN_RE = /^gh[pousr]_[A-Za-z0-9]{20,255}$/;

export function checkToken(raw: string): { token: string } | { error: string } {
  const token = raw.trim();
  if (!token) return { error: 'Paste your token.' };
  if (OTHER_GITHUB_TOKEN_RE.test(token)) {
    return {
      error: 'That is a classic token, which can have broad access. Create a fine-grained token with read-only access instead (see the steps below).',
    };
  }
  if (!FINE_GRAINED_RE.test(token)) return { error: "That doesn't look like a GitHub fine-grained token (it should start with github_pat_)." };
  return { token };
}

/** Removes anything token-shaped from text before it is shown or logged. */
export const redact = (text: string) =>
  text.replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g, '[redacted]');

/**
 * Labels to ignore, from a comma-separated list. They're only compared against PR labels inside the
 * app and are never put into a search query. Limits keep the stored value small and printable.
 */
export const MAX_LABELS = 10;
export const MAX_LABEL_LENGTH = 50;
export function parseLabels(input: string): string[] | { error: string } {
  const labels = input
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  if (labels.length > MAX_LABELS) return { error: `Up to ${MAX_LABELS} labels.` };
  for (const l of labels) {
    if (l.length > MAX_LABEL_LENGTH) return { error: `Labels can be up to ${MAX_LABEL_LENGTH} characters.` };
    // Printable characters only: no control characters or line breaks.
    if (/[\p{Cc}\p{Cf}]/u.test(l)) return { error: 'Labels can only contain printable characters.' };
  }
  return [...new Set(labels)];
}

/** The only GitHub pages the app ever links to: a pull request, and the token settings page. */
const ALLOWED_PATHS = [/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+\/?$/, /^\/settings\/personal-access-tokens\/?$/];

/**
 * Returns the link in normalized form if it may be opened in the browser, else null.
 * Parsed with URL (not a string-prefix check), so lookalikes like https://github.com.evil.example or
 * https://user@evil.example fail; and only pull-request pages and the token settings page are allowed,
 * so even a bad link from GitHub's data can't send someone to, say, an app-authorization page.
 */
export function allowedGitHubLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    const ok =
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ALLOWED_PATHS.some((re) => re.test(url.pathname));
    return ok ? url.href : null;
  } catch {
    return null;
  }
}
