// `npm run check`: tests the counting rules, input validation, read-only and link allowlists, panel
// placement and color contrast without touching GitHub, then scans the source for unsafe patterns.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_WINDOW_DAYS, parseWindow } from '../src/shared/args';
import { reviewRatio, SUPER_MESSAGES } from '../src/shared/ratio';
import { allowedGitHubLink, checkToken, isValidLogin, MAX_LOGIN_LENGTH, parseLabels, redact } from '../src/shared/validate';
import { assertReadOnlyQuery, ENDPOINT, GitHubError, graphql, QUERIES, setTransport, type Actor } from '../src/main/github';
import { panelPosition } from '../src/main/placement';
import {
  buildSearchQueries, hasIgnoredLabel, humanReviewers, makeLocalDate, reviewedInWindow, shiftDay, type ReviewNode,
} from '../src/main/rules';

let failures = 0;
const ok = (msg: string) => console.log(`  ok   ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const expect = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const section = (name: string) => console.log(`\n${name}`);

// ---------- dates ----------
section('Dates');
expect(!('error' in parseWindow('2026-11-09', '2026-11-21')), 'accepts a valid window');
expect(!('error' in parseWindow('2026-11-10', '2026-11-10')), 'accepts a one-day window');
expect('error' in parseWindow('2026-11-21', '2026-11-09'), 'rejects reversed dates');
expect('error' in parseWindow('2026-13-01', '2026-13-05'), 'rejects month 13');
expect('error' in parseWindow('2026-02-30', '2026-03-01'), 'rejects Feb 30');
expect('error' in parseWindow('', '2026-11-21'), 'rejects a missing date');
expect('error' in parseWindow('2026-01-01', '2026-12-31'), `rejects windows over ${MAX_WINDOW_DAYS} days`);
expect(shiftDay('2026-11-10', -1) === '2026-11-09' && shiftDay('2026-12-31', 1) === '2027-01-01', 'shiftDay crosses month and year');

// ---------- counting rules ----------
const user = (login: string): Actor => ({ login, __typename: 'User' });
const bot = (login: string): Actor => ({ login, __typename: 'Bot' });
const review = (author: Actor | null, state: string, submittedAt: string | null = '2026-11-12T15:00:00Z'): ReviewNode => ({
  author,
  state,
  submittedAt,
});
// Pinned to a half-hour-offset zone (UTC+5:30) so the edge cases don't depend on the machine running the check.
const local = makeLocalDate('Asia/Kolkata');
const w = { from: '2026-11-10', to: '2026-11-21' };

section('Reviewed in window');
// 19:00 UTC on the 9th is 00:30 on the 10th locally: inside the window although the UTC date isn't.
expect(reviewedInWindow('alice', [review(user('alice'), 'APPROVED', '2026-11-09T19:00:00Z')], w, local), 'a review just after local midnight on the first day counts');
expect(!reviewedInWindow('alice', [review(user('alice'), 'APPROVED', '2026-11-09T18:00:00Z')], w, local), 'a review late on the day before (local) does not count');
// 19:00 UTC on the 21st is 00:30 on the 22nd locally: outside the window although the UTC date isn't.
expect(!reviewedInWindow('alice', [review(user('alice'), 'COMMENTED', '2026-11-21T19:00:00Z')], w, local), 'a review just after the last day ends (local) does not count');
expect(reviewedInWindow('alice', [review(user('alice'), 'COMMENTED', '2026-11-21T18:00:00Z')], w, local), 'a review late on the last day (local) counts');
expect(reviewedInWindow('alice', [review(user('Alice'), 'CHANGES_REQUESTED')], w, local), 'logins match case-insensitively');
expect(reviewedInWindow('alice', [review(user('alice'), 'DISMISSED')], w, local), 'a dismissed review still counts (any state)');
expect(!reviewedInWindow('alice', [review(user('alice'), 'PENDING', null)], w, local), 'an unsent (PENDING) review does not count');
expect(!reviewedInWindow('alice', [review(user('bob'), 'APPROVED')], w, local), "someone else's review does not count");

section('Need reviewers');
expect(humanReviewers('carol', [review(user('a'), 'APPROVED'), review(user('a'), 'COMMENTED')]).length === 1, 'the same reviewer twice counts once');
expect(humanReviewers('carol', [review(user('carol'), 'COMMENTED'), review(user('a'), 'COMMENTED')]).length === 1, "the author's own review doesn't count");
expect(humanReviewers('carol', [review(bot('copilot'), 'COMMENTED'), review(user('dependabot[bot]'), 'APPROVED')]).length === 0, 'bot reviews do not count');
expect(humanReviewers('carol', [review(user('a'), 'PENDING', null), review(user('b'), 'APPROVED')]).length === 1, 'a pending review does not count');
expect(humanReviewers('carol', [review(user('a'), 'DISMISSED'), review(user('b'), 'CHANGES_REQUESTED')]).length === 2, 'any submitted state counts toward the two');
expect(hasIgnoredLabel(['Do Not Review'], ['do not review']) && !hasIgnoredLabel(['bug'], ['do not review']), 'ignore-labels match case-insensitively');

section('Review ratio');
const r = reviewRatio;
expect(r(4, 2).status === 'good' && r(4, 2).display === '2.00', 'exactly 2.0 is green');
expect(r(7, 4).status === 'warn', 'exactly 1.75 is orange');
expect(r(17, 10).status === 'bad', '1.7 is red');
expect(r(1999, 1000).status === 'good', 'a value shown as 2.00 is green');
expect(r(399, 100).status === 'good', '3.99 is green, not super');
expect(r(8, 2).status === 'super' && SUPER_MESSAGES.includes(r(8, 2).label), '4.0 is super-powered with a fun message');
expect(r(9, 2).label === r(18, 4).label, 'the same ratio always gets the same message');
expect(r(5, 0).status === 'none' && r(5, 0).value === null, 'no authored PRs: no ratio');

// ---------- validation and injection ----------
section('Usernames and organizations');
for (const good of ['octocat', 'octo-org', 'a', 'A1-b2', 'alice_acme', 'x'.repeat(MAX_LOGIN_LENGTH)]) {
  expect(isValidLogin(good), `accepts "${good.length > 12 ? good.slice(0, 12) + '…' : good}"`);
}
for (const bad of ['', '-lead', '_lead', 'trail-', 'two--hyphens', 'x'.repeat(MAX_LOGIN_LENGTH + 1), 'alice repo:victim/private', 'alice\nrepo:x', 'a"b', 'org:other', 'a b', 'ünï']) {
  expect(!isValidLogin(bad), `rejects ${JSON.stringify(bad)}`);
}

section('Search queries');
const q = buildSearchQueries('Organization', 'octo-org', 'alice', w);
expect(q.authored === 'org:octo-org is:pr author:alice created:2026-11-09..2026-11-22', 'authored query (org scope, widened a day each side)');
expect(q.reviewed === 'org:octo-org is:pr reviewed-by:alice -author:alice updated:>=2026-11-09', 'reviewed query');
expect(q.open === 'org:octo-org is:pr is:open draft:false', 'open-PR query');
expect(buildSearchQueries('User', 'alice', 'alice', w).open.startsWith('user:alice '), 'user scope uses user:');
expect(throws(() => buildSearchQueries('Organization', 'octo-org repo:victim/x', 'alice', w)), 'an injected owner is refused');
expect(throws(() => buildSearchQueries('Organization', 'octo-org', 'alice OR is:open', w)), 'an injected login is refused');
expect(throws(() => buildSearchQueries('Organization', 'octo-org', 'alice', { from: '2026-11-09 repo:x', to: '2026-11-21' })), 'injected dates are refused');

section('Labels');
const labels = parseLabels(' Do Not Review , wip,WIP ');
expect(Array.isArray(labels) && labels.join('|') === 'do not review|wip', 'labels are trimmed, lower-cased and de-duplicated');
expect(!Array.isArray(parseLabels('a,'.repeat(11))), 'too many labels are refused');
expect(!Array.isArray(parseLabels('x'.repeat(51))), 'an over-long label is refused');
expect(!Array.isArray(parseLabels('bad\u0000label')), 'control characters are refused');

section('Tokens');
const fine = `github_pat_${'A1b2'.repeat(10)}`;
expect('token' in checkToken(` ${fine} `), 'a fine-grained token is accepted (and trimmed)');
expect('error' in checkToken(`ghp_${'a'.repeat(36)}`), 'a classic token is refused');
expect('error' in checkToken('hello'), 'junk is refused');
expect('error' in checkToken(''), 'empty is refused');
expect(redact(`failed for ${fine} and ghp_${'b'.repeat(36)}`) === 'failed for [redacted] and [redacted]', 'tokens are redacted from messages');

section('Read-only GraphQL allowlist');
expect(Object.values(QUERIES).every((doc) => !throws(() => assertReadOnlyQuery(doc))), 'every built-in query is allowed');
expect(throws(() => assertReadOnlyQuery('mutation { deleteRepository(input: {}) { clientMutationId } }')), 'a mutation is refused');
expect(throws(() => assertReadOnlyQuery('query { viewer { login } }')), 'a query that is not on the allowlist is refused');
expect(Object.values(QUERIES).every((doc) => /^\s*query\b/.test(doc) && !/\bmutation\b/i.test(doc)), 'no built-in document is a mutation');

section('Link allowlist');
for (const good of ['https://github.com/octo-org/web.app/pull/12', 'https://github.com/settings/personal-access-tokens']) {
  expect(allowedGitHubLink(good) === good, `opens ${good}`);
}
expect(allowedGitHubLink('https://GITHUB.com/octo-org/repo/pull/1') === 'https://github.com/octo-org/repo/pull/1', 'opens the normalized form, not the raw string');
for (const bad of [
  'http://github.com/octo-org/repo/pull/1',
  'https://github.com.evil.example/octo-org/repo/pull/1',
  'https://evil.example/github.com/octo-org/repo/pull/1',
  'https://user@github.com/octo-org/repo/pull/1',
  'https://github.com:8443/octo-org/repo/pull/1',
  'https://github.com/login/oauth/authorize?client_id=x',
  'https://github.com/apps/some-app/installations/new',
  'https://github.com/octo-org/repo/pull/1?evil=1',
  'https://github.com/octo-org/repo/settings',
  'javascript:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'not a url',
]) {
  expect(allowedGitHubLink(bad) === null, `refuses ${bad}`);
}

section('GitHub transport (with a fake network)');
const fineToken = `github_pat_${'Z9y8'.repeat(10)}`;
const calls: Array<{ url: string; init: RequestInit }> = [];
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  setTransport(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
respond(200, { data: { viewer: { login: 'alice' } } });
const viewer = await graphql<{ viewer: { login: string } }>(fineToken, QUERIES.viewer);
const sent = calls[0]!;
expect(viewer.viewer.login === 'alice', 'a query returns its data');
expect(sent.url === ENDPOINT && ENDPOINT === 'https://api.github.com/graphql', 'requests go only to https://api.github.com/graphql');
expect(sent.init.redirect === 'error', 'redirects are refused (the token is never forwarded)');
expect(new Headers(sent.init.headers).get('authorization') === `Bearer ${fineToken}`, 'the token travels only in the Authorization header');
expect(!String(sent.init.body).includes(fineToken), 'the token is never in the request body');
let threw: unknown = await graphql(fineToken, 'mutation { x }').then(() => null, (e) => e);
expect(threw instanceof Error && calls.length === 1, 'a mutation is refused before anything is sent');
respond(429, { message: 'slow down' }, { 'retry-after': '120' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && (threw.retryAt ?? 0) >= Date.now() + 110_000, 'a rate limit (429) reports when to try again');
respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && (threw.retryAt ?? 0) >= Date.now() + 55_000, 'a rate limit with no reset time still waits at least a minute');
respond(401, { message: 'Bad credentials' });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && /token/i.test(threw.message) && !threw.message.includes(fineToken), 'a rejected token gives a clear message without the token');
respond(200, { errors: [{ message: `Bad token ${fineToken}` }] });
threw = await graphql(fineToken, QUERIES.viewer).then(() => null, (e) => e);
expect(threw instanceof GitHubError && !threw.message.includes(fineToken) && threw.message.includes('[redacted]'), 'GitHub error messages are redacted');

// ---------- panel placement ----------
section('Panel placement (1920x1080 display, 380x600 panel)');
const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
const size = { width: 380, height: 600 };
const inside = (p: { x: number; y: number }, wa: typeof bounds) =>
  p.x >= wa.x && p.y >= wa.y && p.x + size.width <= wa.x + wa.width && p.y + size.height <= wa.y + wa.height;
const bottom = { x: 0, y: 0, width: 1920, height: 1032 };
const pb = panelPosition({ x: 1800, y: 1040, width: 24, height: 24 }, { bounds, workArea: bottom }, size, 'win32');
expect(inside(pb, bottom) && pb.y + size.height === 1032 - 8, 'bottom taskbar: panel sits just above it');
const top = { x: 0, y: 48, width: 1920, height: 1032 };
const pt = panelPosition({ x: 1800, y: 12, width: 24, height: 24 }, { bounds, workArea: top }, size, 'win32');
expect(inside(pt, top) && pt.y === 48 + 8, 'top taskbar: panel sits just below it');
const left = { x: 60, y: 0, width: 1860, height: 1080 };
const pl = panelPosition({ x: 18, y: 900, width: 24, height: 24 }, { bounds, workArea: left }, size, 'win32');
expect(inside(pl, left) && pl.x === 60 + 8, 'left taskbar: panel sits beside it');
const right = { x: 0, y: 0, width: 1860, height: 1080 };
const pr = panelPosition({ x: 1878, y: 900, width: 24, height: 24 }, { bounds, workArea: right }, size, 'win32');
expect(inside(pr, right) && pr.x + size.width === 1860 - 8, 'right taskbar: panel sits beside it');
const menuBar = { x: 0, y: 25, width: 1920, height: 1055 };
const pm = panelPosition({ x: 1700, y: 0, width: 22, height: 24 }, { bounds, workArea: menuBar }, size, 'darwin');
expect(inside(pm, menuBar) && pm.y === 25 + 8, 'Mac menu bar: panel drops down below it');
const corner = panelPosition({ x: 1910, y: 1040, width: 24, height: 24 }, { bounds, workArea: bottom }, size, 'win32');
expect(inside(corner, bottom), 'an icon in the far corner still keeps the panel on screen');

// ---------- color contrast (read straight from styles.css) ----------
section('Color contrast (4.5:1 minimum for text)');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(appDir, 'src/renderer/styles.css'), 'utf8');
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]));
const lightTokens = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkTokens = { ...lightTokens, ...tokens(css.slice(darkStart, css.indexOf('\n}\n', darkStart))) };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]) => {
  const [r2, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r2! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** color-mix(in srgb, fg p%, transparent) laid over bg. */
const tint = (fg: string, p: number, bg: string) => rgb(fg).map((v, i) => v * p + rgb(bg)[i]! * (1 - p));
for (const [name, t] of [
  ['light', lightTokens],
  ['dark', darkTokens],
] as const) {
  const pairs: Array<[string, number[], number[]]> = [
    ['text on panel', rgb(t.text!), rgb(t.panel!)],
    ['text on card', rgb(t.text!), rgb(t.card!)],
    ['muted on panel', rgb(t.muted!), rgb(t.panel!)],
    ['muted on card', rgb(t.muted!), rgb(t.card!)],
    ['button text on accent', rgb(t['accent-text']!), rgb(t.accent!)],
    ['accent badge on card', rgb(t.accent!), tint(t.accent!, 0.12, t.card!)],
    ['accent icon on card', rgb(t.accent!), tint(t.accent!, 0.14, t.card!)],
    ['error text', rgb(t['error-text']!), rgb(t['error-bg']!)],
    ['ratio green', rgb(t.good!), rgb(t['good-bg']!)],
    ['ratio orange', rgb(t.warn!), rgb(t['warn-bg']!)],
    ['ratio red', rgb(t.bad!), rgb(t['bad-bg']!)],
  ];
  for (const [label, fg, bg] of pairs) {
    const c = contrast(fg, bg);
    expect(c >= 4.5, `${name}: ${label} ${c.toFixed(2)}:1`);
  }
}
for (const stop of ['#4c1d95', '#9d174d', '#b45309']) {
  const c = contrast(rgb('#ffffff'), rgb(stop));
  expect(c >= 4.5, `super card: white on ${stop} ${c.toFixed(2)}:1`);
}

// ---------- source scan ----------
section('Source scan');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const source = files(join(appDir, 'src')).map((f) => ({ path: relative(appDir, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }));
const offenders = (re: RegExp, only?: (path: string) => boolean) =>
  source.filter((f) => (!only || only(f.path)) && re.test(f.text)).map((f) => f.path);
const none = (list: string[], msg: string) => expect(list.length === 0, `${msg}${list.length ? `: ${list.join(', ')}` : ''}`);

none(offenders(/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML|document\.write/), 'no raw HTML injection');
none(offenders(/\beval\s*\(|new Function\s*\(/), 'no eval or new Function');
none(offenders(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false|allowRunningInsecureContent/), 'no weakened Electron settings');
none(offenders(/\bfetch\s*\(/, (p) => p !== 'src/main/transport.ts'), 'only src/main/transport.ts makes network requests');
none(offenders(/data:/, (p) => p === 'src/renderer/index.html' || p === 'src/main/security.ts'), 'the CSP allows no data: URLs');
none(offenders(/http:\/\//), 'no plain-http URLs');
none(offenders(/child_process|execFile|\bspawn\(|shell\.openPath|shell\.openExternal/, (p) => p !== 'src/main/security.ts'), 'no shell commands; only security.ts opens links');
none(offenders(/from ['"](\.\.\/main|electron)/, (p) => p.startsWith('src/renderer/')), 'the UI never imports Electron or main-process code');
none(offenders(/from ['"](?!electron['"]|\.\.\/shared\/)/, (p) => p.startsWith('src/preload/')), 'the preload only imports electron and shared types');
none(offenders(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/), 'raw ipcRenderer is never exposed');
const mainSrc = source.find((f) => f.path === 'src/main/main.ts')?.text ?? '';
expect(/^refuseDangerousSwitches\(\);/m.test(mainSrc), 'main.ts refuses unsafe Chromium switches at startup');
const html = source.find((f) => f.path === 'src/renderer/index.html')?.text ?? '';
expect(/connect-src 'none'/.test(html) && /script-src 'self'/.test(html), "index.html CSP blocks network access and foreign scripts");
const security = source.find((f) => f.path === 'src/main/security.ts')?.text ?? '';
expect(/"connect-src 'none'"/.test(security) && !/unsafe-inline|unsafe-eval/.test(security), 'the CSP response header blocks network access, inline and eval');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
