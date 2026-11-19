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
import type { AppState, Metric, SprintMetrics, SprintSettings } from '../../src/shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'screenshots');

const settings: SprintSettings = { owner: 'octo-org', login: 'alice', from: '2026-11-09', to: '2026-11-21', ignoreLabels: [] };
const baseState: AppState = {
  view: 'metrics',
  hasToken: true,
  tokenPersisted: true,
  viewerLogin: 'alice',
  settings,
  theme: 'system',
  pinned: false,
  openAtLogin: false,
  canOpenAtLogin: true,
  refreshAvailableAt: 0,
};
const pr = (n: number, title: string, repo = 'octo-org/web-app', extra = {}) => ({
  repo,
  number: n,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  author: 'bob',
  ...extra,
});
const metric = (count: number, prs = [pr(101, 'Add the settings page'), pr(102, 'Fix flaky date test', 'octo-org/api')]): Metric => ({
  count,
  prs,
  capped: false,
  searchTotal: count,
});
const metrics = (authored: number, reviewed: number): SprintMetrics => ({
  settings,
  ownerType: 'Organization',
  timezone: 'America/Toronto',
  fetchedAt: '2026-11-19T14:42:00Z',
  authored: metric(authored),
  reviewed: metric(reviewed),
  needsReviewers: metric(3, [
    pr(88, 'Migrate the billing worker to the new queue', 'octo-org/api', { reviewerCount: 0, author: 'carol' }),
    pr(93, 'Dark mode for the dashboard', 'octo-org/web-app', { reviewerCount: 1, author: 'dave' }),
  ]),
});

interface Scenario {
  name: string;
  state: AppState;
  metrics?: SprintMetrics;
  expand?: boolean;
}
const scenarios: Scenario[] = [
  { name: 'token', state: { ...baseState, view: 'token', hasToken: false, settings: null } },
  { name: 'start', state: { ...baseState, view: 'start' } },
  { name: 'metrics-good', state: baseState, metrics: metrics(5, 12) },
  { name: 'metrics-warn', state: baseState, metrics: metrics(10, 18) },
  { name: 'metrics-bad', state: baseState, metrics: metrics(10, 9) },
  { name: 'metrics-super', state: { ...baseState, pinned: true }, metrics: metrics(4, 19) },
  { name: 'metrics-expanded', state: baseState, metrics: metrics(5, 12), expand: true },
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
      if (s.expand) {
        await win.webContents.executeJavaScript(`document.querySelectorAll('.metric-head')[2]?.click()`);
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
