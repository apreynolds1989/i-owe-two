// Electron main process: owns the tray icon, the panel, the token and every call to GitHub.
// The UI (src/renderer) is sandboxed and can only ask for things through the preload bridge; every
// request is checked here (sender, payload shape, values) before anything happens.
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, Tray, type IpcMainEvent, type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SprintWindow } from '../shared/args';
import {
  EMPTY_HISTORY, historyView, needsChoice, pendingFinalize, recordPeriod, switchSeries, type History,
} from '../shared/history';
import { parsePrView } from '../shared/prView';
import { periodContaining, parseView, sameWindow, TRACKED, validRange, viewWindow, windowDays, type ViewRange } from '../shared/range';
import { reviewRatio, superMinReviews } from '../shared/ratio';
import {
  IPC, type ActionResult, type AppState, type SprintMetrics, type SprintSettings, type StartResult, type Theme, type View,
} from '../shared/types';
import { checkToken, isValidLogin, MAX_LOGIN_LENGTH, parseLabels, redact } from '../shared/validate';
import { CancelledError, GitHubError } from './github';
import { exportHistory, loadHistory, saveHistory } from './history';
import { getOwnerType, getPeriodCounts, getSprintMetrics, getViewerLogin, pause } from './metrics';
import { createPanel, createTray, loadIcon, placeNearTray, trayImage, visibleBounds } from './panel';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { makeLocalDate } from './rules';
import {
  fromOurPage, hardenSession, hardenWebContents, openExternalSafely, refuseDangerousSwitches, registerAppScheme, serveRenderer,
} from './security';
import { canPersist, clearToken, initToken, loadToken, saveToken } from './token';
import { installTransport } from './transport';

// Bundled to dist/main.js; the renderer, preload and icon are found relative to it.
const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(distDir);

const REFRESH_COOLDOWN_MS = 30_000;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const toLocalDate = makeLocalDate(timezone);
/** Today's date where the person is. */
const today = () => toLocalDate(new Date().toISOString());

// ---------- before the app is ready ----------

refuseDangerousSwitches(); // e.g. --ignore-certificate-errors, --remote-debugging-port

// Belt and braces: GitHub calls go through Chromium (transport.ts), which ignores these, but make sure
// nothing in this process can be told to skip certificate checks or trust extra certificates.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
delete process.env.NODE_EXTRA_CA_CERTS;

app.enableSandbox(); // every renderer is sandboxed, whatever its webPreferences say
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  // Already running: the other instance opens its panel (see 'second-instance').
  app.quit();
} else {
  void app.whenReady().then(start);
}

// ---------- state ----------

let prefs: Prefs = loadPrefs();
const loaded = loadHistory();
let history: History = loaded.history;
/** A history file written by a newer version of the app is shown as empty and never overwritten. */
const historyReadOnly = loaded.readOnly;
/** A temporary look at other dates. Kept in memory only: never saved, never recorded in history. */
let viewing: ViewRange = TRACKED;
/** The latest numbers for the tracked range: the tray always shows these, whatever is being viewed. */
let lastTracked: SprintMetrics | null = null;
/** The tracked period last fetched, to notice when it rolls over. */
let lastTrackedWindow: SprintWindow | null = null;
/** Ended periods whose final fetch failed this session (other than for a rate limit): not retried until restart. */
const finalizeFailed = new Set<string>();
let view: View = 'start';
let viewerLogin: string | null = null;
const ownerTypes = new Map<string, 'User' | 'Organization'>();
let refreshAvailableAt = 0;
let inFlight: Promise<void> | null = null;
let quitting = false;

let win: BrowserWindow;
let tray: Tray;
let icon: NativeImage;
/** While a native dialog is open the panel loses focus; don't hide it (and the dialog's parent) then. */
let dialogOpen = false;

/** The current period of the tracked range. */
const trackedWindow = () => (prefs.settings ? periodContaining(prefs.settings.range, today()) : null);
/** The dates on screen: the tracked period, or the range being viewed. */
function shownWindow() {
  const tracked = trackedWindow();
  return tracked ? viewWindow(viewing, tracked, today()) : null;
}

function state(): AppState {
  return {
    view,
    hasToken: loadToken() !== null,
    tokenPersisted: canPersist(),
    viewerLogin,
    settings: prefs.settings,
    trackedWindow: trackedWindow(),
    viewing,
    window: shownWindow(),
    history: historyView(history, historyReadOnly, prefs.settings),
    theme: prefs.theme,
    pinned: prefs.pinned,
    openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    canOpenAtLogin: app.isPackaged,
    refreshAvailableAt,
    prView: prefs.prView,
  };
}

function send(channel: string, value: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}
function pushState() {
  send(IPC.state, state());
  rebuildTrayMenu();
}
function updatePrefs(change: Partial<Prefs>) {
  prefs = { ...prefs, ...change };
  savePrefs(prefs);
}
function updateHistory(next: History) {
  if (historyReadOnly || next === history) return;
  history = next;
  saveHistory(history);
}

/** A message that's safe to show: our own GitHub errors are already safe; anything else is redacted. */
const safeError = (err: unknown) =>
  err instanceof GitHubError ? err.message : `Something went wrong: ${redact(err instanceof Error ? err.message : String(err))}`;

// ---------- refreshing ----------

async function ownerTypeFor(token: string, owner: string, signal?: AbortSignal) {
  const key = owner.toLowerCase();
  const cached = ownerTypes.get(key);
  if (cached) return cached;
  const type = await getOwnerType(token, owner, signal);
  ownerTypes.set(key, type);
  return type;
}

/** Minimum gap between forced refreshes (new settings or token), so rapid re-submits can't flood GitHub. */
const FORCED_MIN_GAP_MS = 5_000;
/** Set from GitHub's reset time after a rate limit; no refresh of any kind is sent before it. */
let rateLimitedUntil = 0;
let lastStartedAt = 0;
let controller: AbortController | null = null;
let queued = false;
let forcedTimer: ReturnType<typeof setTimeout> | null = null;

/** Stop any refresh in progress and anything queued (used when the token is removed). */
function cancelRefresh() {
  queued = false;
  if (forcedTimer) clearTimeout(forcedTimer);
  forcedTimer = null;
  controller?.abort();
}

/**
 * Fetch and push fresh numbers.
 * - Manual refreshes are limited to one per 30 seconds; a refresh already running is reused.
 * - `force` (new settings or a new token) skips that cooldown, but is still spaced 5 s apart, and it
 *   cancels a refresh still running for the old settings, then runs once that has stopped.
 * - After GitHub rate-limits, nothing at all is sent until GitHub's reset time.
 */
function refresh(force = false): void {
  if (inFlight) {
    if (force) {
      queued = true;
      controller?.abort(); // its numbers would be for the old settings or token
    }
    return;
  }
  const token = loadToken();
  const settings = prefs.settings;
  const tracked = trackedWindow();
  if (!token || !settings || !tracked) return;
  const now = Date.now();
  if (now < rateLimitedUntil) {
    const mins = Math.max(1, Math.ceil((rateLimitedUntil - now) / 60_000));
    send(IPC.result, { ok: false, error: `GitHub's rate limit was reached. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.` });
    return;
  }
  if (!force && now < refreshAvailableAt) return;
  if (force && now - lastStartedAt < FORCED_MIN_GAP_MS) {
    if (forcedTimer) clearTimeout(forcedTimer);
    forcedTimer = setTimeout(() => {
      forcedTimer = null;
      refresh(true);
    }, FORCED_MIN_GAP_MS - (now - lastStartedAt));
    return;
  }

  lastStartedAt = now;
  refreshAvailableAt = now + REFRESH_COOLDOWN_MS;
  // Captured now: if the view or settings change mid-fetch, this refresh is cancelled and run again.
  const isTracked = viewing.kind === 'tracked';
  const window = viewWindow(viewing, tracked, today());
  lastTrackedWindow = tracked;
  const ac = new AbortController();
  controller = ac;
  pushState();
  inFlight = (async () => {
    send(IPC.loading, true);
    try {
      const ownerType = await ownerTypeFor(token, settings.owner, ac.signal);
      if (isTracked) await finalizeEndedPeriod(token, settings, tracked, ownerType, ac.signal);
      const metrics = await getSprintMetrics(token, settings, window, ownerType, timezone, ac.signal);
      if (ac.signal.aborted) return;
      if (isTracked) {
        lastTracked = metrics;
        updateTray();
        const counts = { authored: metrics.authored.count, reviewed: metrics.reviewed.count };
        updateHistory(recordPeriod(history, settings, { ...window, ...counts, final: false }, new Date().toISOString()));
      }
      send(IPC.result, { ok: true, metrics });
    } catch (err) {
      if (ac.signal.aborted || err instanceof CancelledError) return; // superseded: nothing to report
      if (err instanceof GitHubError && err.retryAt) {
        rateLimitedUntil = err.retryAt;
        refreshAvailableAt = Math.max(refreshAvailableAt, err.retryAt);
      }
      send(IPC.result, { ok: false, error: safeError(err) });
    } finally {
      send(IPC.loading, false);
    }
  })().finally(() => {
    inFlight = null;
    controller = null;
    pushState();
    if (queued) {
      queued = false;
      refresh(true);
    }
  });
}

/**
 * If the tracked range's last recorded period has ended without being locked in (it rolled over while the
 * app was running, closed or asleep), fetch its counts one last time and mark it final. A failure here
 * never blocks the current numbers: the period just stays "partial". Rate limits and cancelling still
 * stop the whole refresh, as everywhere else.
 */
async function finalizeEndedPeriod(
  token: string,
  settings: SprintSettings,
  tracked: SprintWindow,
  ownerType: 'User' | 'Organization',
  signal: AbortSignal,
) {
  const ended = pendingFinalize(history, settings, tracked);
  if (!ended || historyReadOnly) return;
  const key = `${ended.from}|${ended.to}`;
  if (finalizeFailed.has(key)) return;
  try {
    const counts = await getPeriodCounts(token, settings, ended, ownerType, timezone, signal);
    if (signal.aborted) return;
    updateHistory(recordPeriod(history, settings, { from: ended.from, to: ended.to, ...counts, final: true }, new Date().toISOString()));
    await pause(signal);
  } catch (err) {
    if (signal.aborted || err instanceof CancelledError || (err instanceof GitHubError && err.retryAt)) throw err;
    finalizeFailed.add(key);
  }
}

/** Notices a new tracked period (after midnight, waking from sleep, or opening the panel) and fetches it. */
function checkRollover() {
  const tracked = trackedWindow();
  if (!tracked || !lastTrackedWindow || sameWindow(tracked, lastTrackedWindow)) return;
  viewing = TRACKED; // a temporary view belonged to the old period
  pushState();
  refresh(true);
}

let midnightTimer: ReturnType<typeof setTimeout> | null = null;
/** Checks for a rollover just after each local midnight. Nothing else runs in the background. */
function scheduleMidnightCheck() {
  if (midnightTimer) clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 5, 0); // a few seconds past midnight, local time
  midnightTimer = setTimeout(() => {
    checkRollover();
    scheduleMidnightCheck();
  }, next.getTime() - now.getTime());
}

// ---------- tray and panel ----------

/** The tray shows the tracked range's standing (never a temporary view): a coloured dot and a tooltip. */
function updateTray() {
  const m = lastTracked;
  if (!m) {
    tray.setImage(trayImage(icon, 'none'));
    tray.setToolTip('ReciPRocity');
    return;
  }
  const r = reviewRatio(m.reviewed.count, m.authored.count, superMinReviews(windowDays(m.window)));
  tray.setImage(trayImage(icon, r.status));
  tray.setToolTip(`ReciPRocity · ratio ${r.display} · ${r.label}`);
}

function setView(next: View) {
  // Only show screens that make sense: metrics needs both a token and settings.
  if (!loadToken()) view = 'token';
  else if (next === 'metrics' && !prefs.settings) view = 'start';
  else view = next;
  pushState();
}

let lastHiddenAt = 0;
function hidePanel() {
  if (win.isVisible()) {
    win.hide();
    lastHiddenAt = Date.now();
  }
}

function showPanel() {
  checkRollover();
  const pinnedAt = prefs.pinned ? visibleBounds(prefs.pinnedBounds) : null;
  if (pinnedAt) win.setBounds(pinnedAt);
  else placeNearTray(win, tray);
  win.show();
  win.focus();
}

function togglePanel() {
  if (win.isVisible()) return hidePanel();
  // Clicking the tray icon first blurs (and so hides) an open panel; don't immediately reopen it.
  if (Date.now() - lastHiddenAt < 300) return;
  showPanel();
}

function setPinned(pinned: boolean) {
  win.setAlwaysOnTop(pinned, 'floating');
  updatePrefs({ pinned, pinnedBounds: pinned ? win.getBounds() : prefs.pinnedBounds });
  if (!pinned) placeNearTray(win, tray);
  pushState();
}

function setTheme(theme: Theme) {
  // The page follows prefers-color-scheme, which Electron derives from themeSource.
  nativeTheme.themeSource = theme;
  updatePrefs({ theme });
  pushState();
}

function setOpenAtLogin(openAtLogin: boolean) {
  if (!app.isPackaged) return; // only meaningful for the installed app
  app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
  pushState();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = state();
  const themeItem = (label: string, value: Theme) => ({
    label,
    type: 'radio' as const,
    checked: prefs.theme === value,
    click: () => setTheme(value),
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Open ReciPRocity', click: showPanel },
    { label: 'Refresh', enabled: s.hasToken && !!s.settings, click: () => refresh() },
    { type: 'separator' },
    { label: 'Change range…', enabled: s.hasToken, click: () => (setView('start'), showPanel()) },
    { label: 'Change token…', click: () => (setView('token'), showPanel()) },
    { type: 'separator' },
    { label: 'Theme', submenu: [themeItem('System', 'system'), themeItem('Light', 'light'), themeItem('Dark', 'dark')] },
    { label: 'Pin panel', type: 'checkbox', checked: prefs.pinned, click: (item) => setPinned(item.checked) },
    {
      label: app.isPackaged ? 'Start at login' : 'Start at login (installed app only)',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: s.openAtLogin,
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit ReciPRocity', click: () => app.quit() },
  ]);
  tray.removeAllListeners('right-click');
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

// ---------- IPC: every handler checks the sender, then the payload ----------

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('Rejected IPC from an unknown sender.');
    return fn(event, ...args);
  });
}
function on(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromOurPage(event)) fn(event, ...args);
  });
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);

/** Runs a native dialog without the panel hiding itself (and so its dialog) when focus moves to it. */
async function withDialog<T>(fn: () => Promise<T>): Promise<T> {
  dialogOpen = true;
  try {
    return await fn();
  } finally {
    dialogOpen = false;
  }
}
const isView = (v: unknown): v is View => v === 'token' || v === 'start' || v === 'metrics';
const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';

function registerIpc() {
  handle(IPC.getState, () => state());

  handle(IPC.saveToken, async (_e, raw): Promise<ActionResult> => {
    const input = str(raw, 400);
    if (input === null) return { ok: false, error: 'That token is too long.' };
    const checked = checkToken(input);
    if ('error' in checked) return { ok: false, error: checked.error };
    let login: string;
    try {
      // Prove the token works before keeping it.
      login = await getViewerLogin(checked.token);
    } catch (err) {
      return { ok: false, error: safeError(err) };
    }
    try {
      await saveToken(checked.token);
    } catch {
      return { ok: false, error: "The token couldn't be saved on this computer. Nothing was changed." };
    }
    cancelRefresh(); // anything running belongs to the previous token
    viewerLogin = login;
    ownerTypes.clear();
    setView(prefs.settings ? 'metrics' : 'start');
    if (prefs.settings) refresh(true);
    return { ok: true };
  });

  handle(IPC.clearToken, async () => {
    cancelRefresh(); // a refresh in progress must not keep using the removed token
    await clearToken();
    viewerLogin = null;
    ownerTypes.clear();
    lastTracked = null;
    updateTray();
    setView('token');
  });

  handle(IPC.start, async (_e, raw): Promise<StartResult> => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid request.' };
    const r = raw as Record<string, unknown>;
    const owner = str(r.owner, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const login = str(r.login, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const labelsInput = str(r.ignoreLabels, 1000);
    const choice = r.historyChoice === 'archive' || r.historyChoice === 'delete' ? r.historyChoice : null;
    if (!isValidLogin(owner)) return { ok: false, error: 'Enter a valid GitHub username or organization for "Where".' };
    if (!isValidLogin(login)) return { ok: false, error: 'Enter a valid GitHub username.' };
    const range = validRange({ kind: str(r.kind, 20), start: str(r.start, 10) });
    if (!range) return { ok: false, error: 'Choose a range and a valid start date.' };
    const labels = parseLabels(labelsInput ?? '');
    if (!Array.isArray(labels)) return { ok: false, error: labels.error };

    const token = loadToken();
    if (!token) return { ok: false, error: 'Add a token first.' };
    try {
      await ownerTypeFor(token, owner); // fails clearly if the owner doesn't exist
    } catch (err) {
      return { ok: false, error: safeError(err) };
    }
    const settings: SprintSettings = { owner, login, range, ignoreLabels: labels };
    // A new owner, person, range or start date with history behind it: ask before archiving or deleting it.
    const pending = historyReadOnly ? null : needsChoice(history, settings);
    if (pending && !choice) return { ok: false, historyChoice: pending };
    updateHistory(switchSeries(history, settings, choice ?? 'archive', new Date().toISOString()));
    cancelRefresh(); // anything running belongs to the old settings
    updatePrefs({ settings });
    viewing = TRACKED;
    lastTracked = null;
    updateTray();
    setView('metrics');
    refresh(true);
    return { ok: true };
  });

  handle(IPC.setViewing, (_e, raw): ActionResult => {
    const v = parseView(raw);
    if ('error' in v) return { ok: false, error: v.error };
    viewing = v;
    pushState();
    if (v.kind === 'tracked' && lastTracked && sameWindow(lastTracked.window, trackedWindow())) {
      // Back to my range: show the numbers already fetched straight away; refresh only if the cooldown allows.
      controller?.abort(); // a fetch still running for the temporary view is no longer wanted
      send(IPC.result, { ok: true, metrics: lastTracked });
      refresh();
    } else {
      refresh(true);
    }
    return { ok: true };
  });

  handle(IPC.exportHistory, async (): Promise<ActionResult> => {
    const result = await withDialog(() =>
      dialog.showSaveDialog(win, {
        title: 'Export review history',
        defaultPath: join(app.getPath('documents'), `reciprocity-history-${today()}.csv`),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      }),
    );
    if (result.canceled || !result.filePath) return { ok: true };
    try {
      exportHistory(history, result.filePath);
      return { ok: true };
    } catch {
      return { ok: false, error: "The history couldn't be saved there. Try another folder." };
    }
  });

  handle(IPC.clearHistory, async () => {
    if (historyReadOnly) return;
    const { response } = await withDialog(() =>
      dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Clear history', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Clear all review history?',
        detail: "This deletes every recorded period from this computer, including archived ones. It can't be undone: export it first to keep a copy.",
      }),
    );
    if (response !== 0) return;
    let next: History = EMPTY_HISTORY;
    if (lastTracked && prefs.settings) {
      // Start the current period again from the numbers on screen.
      const counts = { authored: lastTracked.authored.count, reviewed: lastTracked.reviewed.count };
      next = recordPeriod(next, prefs.settings, { ...lastTracked.window, ...counts, final: false }, new Date().toISOString());
    }
    updateHistory(next);
    pushState();
  });

  on(IPC.showView, (_e, v) => {
    if (isView(v)) setView(v);
  });
  on(IPC.refresh, () => refresh());
  on(IPC.setTheme, (_e, t) => {
    if (isTheme(t)) setTheme(t);
  });
  on(IPC.setPinned, (_e, p) => {
    if (typeof p === 'boolean') setPinned(p);
  });
  on(IPC.setOpenAtLogin, (_e, o) => {
    if (typeof o === 'boolean') setOpenAtLogin(o);
  });
  on(IPC.setPrView, (_e, v) => {
    const prView = parsePrView(v);
    if (prView) {
      updatePrefs({ prView });
      pushState();
    }
  });
  on(IPC.openExternal, (_e, url) => {
    const u = str(url, 2000);
    if (u) openExternalSafely(u);
  });
  on(IPC.hide, hidePanel);
  on(IPC.quit, () => app.quit());
}

// ---------- startup ----------

async function start() {
  if (process.platform === 'darwin') app.dock?.hide(); // menu-bar app: no Dock icon

  Menu.setApplicationMenu(null); // no default menu, so no built-in shortcuts such as reload
  serveRenderer(join(distDir, 'renderer'));
  hardenSession();
  installTransport();
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));
  nativeTheme.themeSource = prefs.theme;
  await initToken();
  registerIpc();

  icon = loadIcon(appDir);
  tray = createTray(icon);
  updateTray();
  tray.on('click', togglePanel);
  scheduleMidnightCheck();
  // Timers can fire late after sleep: check for a new period as soon as the computer wakes.
  powerMonitor.on('resume', () => {
    scheduleMidnightCheck();
    checkRollover();
  });

  win = createPanel(join(distDir, 'preload.cjs'), icon);
  win.setAlwaysOnTop(prefs.pinned, 'floating');
  win.on('blur', () => {
    if (!prefs.pinned && !dialogOpen) hidePanel();
  });
  win.on('moved', () => {
    if (prefs.pinned) updatePrefs({ pinnedBounds: win.getBounds() });
  });
  // Closing only hides the panel; the app keeps running in the tray until Quit.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePanel();
    }
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !prefs.pinned) hidePanel();
  });

  const token = loadToken();
  view = !token ? 'token' : prefs.settings ? 'metrics' : 'start';
  rebuildTrayMenu();

  // Open the panel on a normal launch; stay in the tray when started at login.
  const atLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  win.once('ready-to-show', () => {
    if (!atLogin) showPanel();
  });

  if (token) {
    try {
      viewerLogin = await getViewerLogin(token);
    } catch {
      // Shown when they refresh; the token screen is one click away.
    }
    pushState();
    if (prefs.settings) refresh(true);
  }
}

app.on('second-instance', () => {
  if (win) showPanel();
});
app.on('before-quit', () => {
  quitting = true;
});
// A tray app: no windows being open is normal, so don't quit.
app.on('window-all-closed', () => undefined);
