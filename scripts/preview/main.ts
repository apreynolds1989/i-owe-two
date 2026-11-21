// Dev-only: renders every screen with made-up data and saves screenshots (light and dark) to
// screenshots/. Run with `npm run screenshots`. Never packaged (electron-builder ships only dist/**,
// and this builds to .preview/). No token, no GitHub calls: the bridge is a fake with fixed data.
import { app, BrowserWindow, ipcMain, nativeTheme, net } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubError, graphql, QUERIES } from '../../src/main/github';
import { hardenSession, hardenWebContents, INDEX_URL, registerAppScheme, serveRenderer } from '../../src/main/security';
import { installTransport } from '../../src/main/transport';
import type { Series } from '../../src/shared/history';
import type { AppState, Metric, Partner, PrListView, PrSummary, ReviewMetrics, TrackedSettings } from '../../src/shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'screenshots');

const settings: TrackedSettings = { owner: 'octo-org', login: 'alice', range: { kind: 'week', start: '2026-11-02' }, ignoreLabels: [] };
const window = { from: '2026-11-16', to: '2026-11-22' };
const period = (from: string, to: string, authored: number, reviewed: number, final = true) => ({
  from, to, authored, reviewed, final, updatedAt: '2026-11-19T14:42:00Z',
});
const partners: Partner[] = [
  { login: 'bob', gave: 4, got: 2 },
  { login: 'carol', gave: 3, got: 1 },
  { login: 'dave', gave: 1, got: 3 },
  { login: 'erin', gave: 2, got: 0 },
  { login: 'frank', gave: 0, got: 1 },
  { login: 'grace', gave: 1, got: 0 },
];
const active: Series = {
  owner: 'octo-org', login: 'alice', kind: 'week', start: '2026-11-02', startedAt: '2026-11-02T09:00:00Z', archivedAt: null,
  periods: [
    { ...period('2026-11-02', '2026-11-08', 4, 9), reviewedFor: 4, reviewedBy: 3 },
    // Remembered teammates (opt-in), so its recap names one.
    { ...period('2026-11-09', '2026-11-15', 5, 11), reviewedFor: 5, reviewedBy: 4, partners: partners.slice(0, 5) },
    period('2026-11-16', '2026-11-22', 5, 12, false),
  ],
};
const baseState: AppState = {
  view: 'metrics',
  hasToken: true,
  tokenPersisted: true,
  viewerLogin: 'alice',
  settings,
  trackedWindow: window,
  viewing: { kind: 'tracked' },
  window,
  history: { active, archived: [], readOnly: false },
  theme: 'system',
  pinned: false,
  openAtLogin: false,
  canOpenAtLogin: true,
  refreshAvailableAt: 0,
  prView: { groupByRepo: false, sort: 'oldest', labels: [] },
  rememberTeammates: false,
  // Already dismissed, so the recap only shows in its own screenshot.
  recapSeen: '2026-11-09|2026-11-15',
};
const pr = (n: number, title: string, repo = 'octo-org/web-app', extra: Partial<PrSummary> = {}): PrSummary => ({
  repo,
  number: n,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  author: 'bob',
  createdAt: '2026-11-15T10:00:00Z',
  ...extra,
});
const metric = (count: number, prs = [pr(101, 'Add the settings page'), pr(102, 'Fix flaky date test', 'octo-org/api')]): Metric => ({
  count,
  prs,
  capped: false,
  searchTotal: count,
});
const metrics = (authored: number, reviewed: number): ReviewMetrics => ({
  settings,
  window,
  ownerType: 'Organization',
  timezone: 'America/Toronto',
  fetchedAt: '2026-11-19T14:42:00Z',
  authored: metric(authored),
  reviewed: metric(reviewed),
  needsReviewers: metric(5, needsReviewers),
  waitingOnYou: metric(5, waitingOnYou),
  yourPrsWaiting: metric(2, yourPrsWaiting),
  partners,
});
const yourPrsWaiting: PrSummary[] = [
  pr(86, 'Add an export button to the audit log', 'octo-org/web-app', { author: 'alice', createdAt: '2026-11-11T10:00:00Z', reviewerCount: 0 }),
  pr(103, 'Retry failed webhook deliveries', 'octo-org/api', { author: 'alice', createdAt: '2026-11-17T10:00:00Z', reviewerCount: 1 }),
];
// One of each kind: a fresh request, a re-request after approving, and the three Involved states.
const waitingOnYou: PrSummary[] = [
  pr(97, 'Retry webhooks with backoff', 'octo-org/api', { reviewerCount: 1, author: 'erin', createdAt: '2026-11-13T10:00:00Z', section: 'requested' }),
  pr(102, 'Cache the org member list', 'octo-org/api', {
    reviewerCount: 2, author: 'frank', createdAt: '2026-11-16T10:00:00Z', section: 'requested', myReview: 'approved',
  }),
  pr(76, 'Split the settings form into steps', 'octo-org/web-app', {
    reviewerCount: 1, author: 'grace', createdAt: '2026-11-06T10:00:00Z', section: 'involved', myReview: 'changes_requested',
  }),
  pr(84, 'Add retries to the deploy script', 'octo-org/infra', {
    reviewerCount: 2, author: 'heidi', createdAt: '2026-11-10T10:00:00Z', section: 'involved', myReview: 'commented',
  }),
  pr(90, 'Rename the billing events', 'octo-org/api', {
    reviewerCount: 1, author: 'ivan', createdAt: '2026-11-15T10:00:00Z', section: 'involved', myReview: 'dismissed',
  }),
];
const waiting = (n: number, title: string, repo: string, createdAt: string, labels: string[], reviewerCount: number, author: string) =>
  pr(n, title, repo, { createdAt, labels, reviewerCount, author });
const needsReviewers = [
  waiting(88, 'Migrate the billing worker to the new queue', 'octo-org/api', '2026-11-03T15:00:00Z', ['backend'], 0, 'carol'),
  waiting(93, 'Dark mode for the dashboard', 'octo-org/web-app', '2026-11-12T10:00:00Z', ['frontend', 'UI'], 1, 'dave'),
  waiting(41, 'Bump the release pipeline to Node 22', 'octo-org/infra', '2026-11-14T09:30:00Z', [], 0, 'erin'),
  waiting(97, 'Paginate the audit log endpoint', 'octo-org/api', '2026-11-17T16:20:00Z', ['backend', 'performance'], 1, 'frank'),
  waiting(99, 'Keyboard shortcuts for the PR table', 'octo-org/web-app', '2026-11-18T11:05:00Z', ['frontend'], 0, 'grace'),
];
const view = (v: Partial<PrListView>) => ({ ...baseState, prView: { ...baseState.prView, ...v } });

interface Scenario {
  name: string;
  state: AppState;
  metrics?: ReviewMetrics;
  /** Expand a card's PR list (cards other than Need reviewers are scrolled into view). */
  expand?: 'needsReviewers' | 'waitingOnYou' | 'yourPrsWaiting';
  /** Open Give & take on the ratio card. */
  ratio?: boolean;
  /** Open the recap of the newest ended period in History. */
  recap?: boolean;
  /** Open the History card (and its archived list) and scroll down to it. */
  history?: boolean;
}
const archivedSeries: Series = {
  owner: 'octo-org', login: 'alice', kind: 'twoWeeks', start: '2026-09-28', startedAt: '2026-09-28T09:00:00Z', archivedAt: '2026-11-02T09:00:00Z',
  periods: [period('2026-09-28', '2026-10-11', 6, 13), period('2026-10-12', '2026-10-25', 7, 12, false)],
};
const scenarios: Scenario[] = [
  { name: 'token', state: { ...baseState, view: 'token', hasToken: false, settings: null } },
  { name: 'start', state: { ...baseState, view: 'start' } },
  { name: 'metrics-good', state: baseState, metrics: metrics(5, 12) },
  { name: 'metrics-warn', state: baseState, metrics: metrics(10, 18) },
  { name: 'metrics-bad', state: baseState, metrics: metrics(10, 9) },
  { name: 'metrics-super', state: { ...baseState, pinned: true }, metrics: metrics(8, 33) },
  {
    name: 'metrics-viewing',
    state: { ...baseState, viewing: { kind: 'lastDays', days: 14 }, window: { from: '2026-11-07', to: '2026-11-20' } },
    metrics: { ...metrics(9, 20), window: { from: '2026-11-07', to: '2026-11-20' } },
  },
  { name: 'metrics-expanded', state: baseState, metrics: metrics(5, 12), expand: 'needsReviewers' },
  { name: 'metrics-waiting', state: baseState, metrics: metrics(5, 12), expand: 'waitingOnYou' },
  { name: 'metrics-your-prs', state: baseState, metrics: metrics(5, 12), expand: 'yourPrsWaiting' },
  { name: 'metrics-give-take', state: baseState, metrics: metrics(5, 12), ratio: true },
  { name: 'metrics-give-take-super', state: baseState, metrics: metrics(8, 33), ratio: true },
  { name: 'metrics-recap', state: { ...baseState, recapSeen: null }, metrics: metrics(5, 12) },
  { name: 'metrics-history-recap', state: baseState, metrics: metrics(5, 12), history: true, recap: true },
  {
    name: 'metrics-history',
    state: { ...baseState, history: { active, archived: [archivedSeries], readOnly: false } },
    metrics: metrics(5, 12),
    history: true,
  },
  { name: 'metrics-grouped', state: view({ groupByRepo: true }), metrics: metrics(5, 12), expand: 'needsReviewers' },
  { name: 'metrics-filtered', state: view({ groupByRepo: true, sort: 'newest', labels: ['frontend'] }), metrics: metrics(5, 12), expand: 'needsReviewers' },
  { name: 'metrics-filter-empty', state: view({ labels: ['security'] }), metrics: metrics(5, 12), expand: 'needsReviewers' },
];

let current: Scenario = scenarios[0]!;
ipcMain.handle('preview:scenario', () => current);

registerAppScheme();
app.disableHardwareAcceleration(); // consistent offscreen captures
void app.whenReady().then(async () => {
  serveRenderer(join(root, 'dist', 'renderer'));
  hardenSession();
  mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({
    width: 380,
    height: 600,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, offscreen: true },
  });
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme;
    for (const s of scenarios) {
      current = s;
      await win.loadURL(INDEX_URL);
      await new Promise((r) => setTimeout(r, 400)); // the fake numbers arrive shortly after load
      if (s.ratio) await win.webContents.executeJavaScript(`document.querySelector('.ratio-head')?.click()`);
      if (s.expand) {
        // Card order: Authored, Reviewed, Waiting on you, Your PRs waiting, Need reviewers.
        const index = { waitingOnYou: 2, yourPrsWaiting: 3, needsReviewers: 4 }[s.expand];
        await win.webContents.executeJavaScript(`document.querySelectorAll('.metric-head')[${index}]?.click()`);
        if (s.expand !== 'needsReviewers') {
          await new Promise((r) => setTimeout(r, 50));
          await win.webContents.executeJavaScript(`document.querySelector('.metric-card.expanded')?.scrollIntoView({ block: 'start' })`);
        }
      }
      if (s.history) {
        await win.webContents.executeJavaScript(`document.querySelector('.history-card .metric-head')?.click()`);
        await new Promise((r) => setTimeout(r, 100));
        const open = s.recap ? `document.querySelectorAll('.history-button')[0]?.click()` : `document.querySelector('.archived-toggle')?.click()`;
        await win.webContents.executeJavaScript(
          `${open}; setTimeout(() => { const c = document.querySelector('.content'); c.scrollTop = c.scrollHeight; }, 50)`,
        );
      }
      await new Promise((r) => setTimeout(r, 900)); // let count-up animations finish
      const image = await win.webContents.capturePage();
      writeFileSync(join(out, `${s.name}-${theme}.png`), image.toPNG());
    }
  }
  console.log(`[screenshots] Saved ${scenarios.length * 2} screenshots to screenshots/.`);

  // Security probes: from inside the real page (same app:// handler, CSP header and session rules as
  // the app), try what a compromised page might, and confirm each attempt is blocked.
  hardenWebContents(win.webContents);
  current = scenarios[2]!;
  await win.loadURL(INDEX_URL);
  const probe = (code: string) => win.webContents.executeJavaScript(code) as Promise<boolean>;
  const results: Array<[string, boolean]> = [
    ['fetch to another site is blocked', await probe(`fetch('https://example.com').then(() => false, () => true)`)],
    ['fetch to the GitHub API is blocked (only the main process may call it)', await probe(`fetch('https://api.github.com/').then(() => false, () => true)`)],
    [
      'remote images are blocked',
      await probe(`new Promise((r) => { const i = new Image(); i.onload = () => r(false); i.onerror = () => r(true); i.src = 'https://github.com/favicon.ico'; })`),
    ],
    [
      'remote scripts are blocked',
      await probe(`new Promise((r) => { const s = document.createElement('script'); s.onload = () => r(false); s.onerror = () => r(true); s.src = 'https://example.com/x.js'; document.head.append(s); })`),
    ],
    ['inline scripts are blocked', await probe(`(() => { window.__ran = false; const s = document.createElement('script'); s.textContent = 'window.__ran = true'; document.head.append(s); return window.__ran === false; })()`)],
    ['eval is blocked', await probe(`(() => { try { eval('1'); return false; } catch { return true; } })()`)],
    ['no Node.js in the page', await probe(`typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'`)],
    ['window.open does not open a window', await probe(`window.open('https://example.com') === null`)],
  ];
  // Navigation attempt: the page must stay on the app.
  await win.webContents.executeJavaScript(`location.href = 'https://example.com'; true`).catch(() => true);
  await new Promise((r) => setTimeout(r, 500));
  results.push(['navigating away is blocked', win.webContents.getURL().startsWith('app://sprint/')]);
  // Path traversal through the app:// handler.
  results.push([
    'app:// cannot read files outside the UI folder',
    await probe(`fetch('app://sprint/..%2F..%2Fpackage.json').then((r) => !r.ok, () => true)`),
  ]);
  results.push(['only one window exists', BrowserWindow.getAllWindows().length === 1]);
  // The page's own fetches are already stopped by the CSP, so test the app:// handler's traversal guard
  // directly from the main process, with encoded forward and back slashes.
  const status = (url: string) => net.fetch(url).then((r) => r.status, () => 0);
  results.push(['app:// serves the UI itself', (await status(INDEX_URL)) === 200]);
  for (const path of ['..%2F..%2Fpackage.json', '..%5C..%5Cpackage.json', '%2E%2E%2F%2E%2E%2Fpackage.json', '../../package.json']) {
    const s = await status(`app://sprint/${path}`);
    results.push([`app:// refuses ${path} (status ${s})`, s === 403 || s === 404]);
  }
  // Cancelled by the session's request filter before the handler even runs (fetch fails: status 0).
  const other = await status('app://elsewhere/index.html');
  results.push([`app:// refuses other hosts (status ${other})`, other !== 200]);

  // The real GitHub transport (Chromium network stack). A deliberately invalid token: GitHub answers
  // 401, which proves the request travelled end to end. No real token is involved.
  installTransport();
  const fake = `github_pat_${'0'.repeat(40)}`;
  const err = await graphql(fake, QUERIES.viewer).then(() => null, (e: unknown) => e);
  results.push(['the GitHub transport reaches api.github.com (invalid token answered with 401)', err instanceof GitHubError && /rejected the token/.test(err.message)]);
  const elsewhere = await net.fetch('https://example.com').then(() => 'reached', () => 'blocked');
  results.push(['the main process session cannot reach other sites either', elsewhere === 'blocked']);

  let failed = 0;
  console.log('\n[probes]');
  for (const [name, passed] of results) {
    if (!passed) failed++;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(failed ? `\n${failed} probe(s) failed` : '\nAll security probes passed');
  app.exit(failed ? 1 : 0);
});
