// Electron main process: owns the tray icon, the panel, the token and every call to GitHub.
// The UI (src/renderer) is sandboxed and can only ask for things through the preload bridge; every
// request is checked here (sender, payload shape, values) before anything happens.
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, Tray, type IpcMainEvent,
  type IpcMainInvokeEvent, type NativeImage,
} from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DateWindow } from '../shared/dateWindow';
import {
  EMPTY_HISTORY, forgetPartners, historyView, isPeriodKey, MAX_STORED_PARTNERS, needsChoice, partnerExtras, pendingFinalize,
  periodKey, recordPeriod, switchSeries, type History,
} from '../shared/history';
import { prLinksText } from '../shared/prLinks';
import { parsePrView } from '../shared/prView';
import { periodContaining, parseView, sameWindow, TRACKED, validRange, viewWindow, windowDays, type ViewRange } from '../shared/range';
import { reviewRatio, superMinReviews } from '../shared/ratio';
import {
  IPC, type ActionResult, type AppState, type OwnerType, type ReviewMetrics, type Screen, type StartResult, type Theme,
  type TrackedSettings,
} from '../shared/types';
import { checkToken, isValidLogin, MAX_LOGIN_LENGTH, parseLabels, redact } from '../shared/validate';
import { CancelledError, GitHubError, rateLimitMessage } from './github';
import { exportHistory, loadHistory, saveHistory } from './history';
import { getMetrics, getOwnerType, getPeriodCounts, getViewerLogin, pause } from './metrics';
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
/** Minimum gap between forced refreshes (new settings or token), so rapid re-submits can't flood GitHub. */
const FORCED_MIN_GAP_MS = 5_000;
/** A tray click right after the panel hid (by losing focus to that same click) shouldn't reopen it. */
const REOPEN_GUARD_MS = 300;

// Longest strings accepted over IPC, checked before any other parsing. Generous, but bounded.
const MAX_TOKEN_INPUT_LENGTH = 400;
/** Room for parseLabels' limit (10 labels of 50 characters) plus separators and spaces. */
const MAX_LABELS_INPUT_LENGTH = 1000;
const MAX_RANGE_KIND_LENGTH = 20;
const DATE_LENGTH = 10; // YYYY-MM-DD
const MAX_URL_LENGTH = 2000;

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
// Not belt and braces: Chromium does read this one, and writes every TLS session key to the file it
// names (often set globally for Wireshark). Removed here, before app ready, so the network service
// never sees it. The --ssl-key-log-file switch is refused above instead, like the other switches.
delete process.env.SSLKEYLOGFILE;

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
const loadedHistory = loadHistory();
let history: History = loadedHistory.history;
/** A history file written by a newer version of the app is shown as empty and never overwritten. */
const historyReadOnly = loadedHistory.readOnly;
/** A temporary look at other dates. Kept in memory only: never saved, never recorded in history. */
let viewing: ViewRange = TRACKED;
/** The latest numbers for the tracked range: the tray always shows these, whatever is being viewed. */
let lastTrackedMetrics: ReviewMetrics | null = null;
/** The latest numbers of any kind (tracked or a temporary view): what "Copy" on Your PRs waiting copies. */
let lastShownMetrics: ReviewMetrics | null = null;
/** The tracked period last fetched, to notice when it rolls over. */
let lastTrackedWindow: DateWindow | null = null;
/** Ended periods whose final fetch failed this session (other than for a rate limit): not retried until restart. */
const finalizeFailed = new Set<string>();
let currentScreen: Screen = 'start';
let viewerLogin: string | null = null;
/** Owner login (lower-cased) to its type, looked up once per token. */
const ownerTypes = new Map<string, OwnerType>();
/** Epoch ms when a manual refresh is allowed again. */
let refreshAvailableAt = 0;
let quitting = false;

let panel: BrowserWindow;
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

/** Everything the UI needs to draw itself (see AppState). */
function state(): AppState {
  return {
    view: currentScreen,
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
    rememberTeammates: prefs.rememberTeammates,
    recapSeen: prefs.recapSeen,
  };
}

/** Sends to the panel's page, if it's still there. */
function send(channel: string, value: unknown) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, value);
}
/** Pushes fresh state to the UI and the tray menu after any change. */
function pushState() {
  send(IPC.state, state());
  rebuildTrayMenu();
}
function updatePrefs(change: Partial<Prefs>) {
  prefs = { ...prefs, ...change };
  savePrefs(prefs);
}
/** Saves a changed history (never a read-only one; an unchanged one isn't rewritten). */
function updateHistory(next: History) {
  if (historyReadOnly || next === history) return;
  history = next;
  saveHistory(history);
}

/**
 * Teammates' logins are only kept when the person opted in, and only while the tracked person is the
 * token's owner: the app never builds a record of who someone else trades reviews with.
 */
const rememberPartnersFor = (settings: TrackedSettings) =>
  prefs.rememberTeammates && !!viewerLogin && settings.login.toLowerCase() === viewerLogin.toLowerCase();

/** The tracked range's current period, recorded (not final) from numbers just fetched. */
function recordCurrent(baseHistory: History, settings: TrackedSettings, metrics: ReviewMetrics): History {
  const counts = {
    authored: metrics.authored.count,
    reviewed: metrics.reviewed.count,
    ...partnerExtras(metrics.partners, rememberPartnersFor(settings)),
  };
  return recordPeriod(baseHistory, settings, { ...metrics.window, ...counts, final: false }, new Date().toISOString());
}

/** A message that's safe to show: our own GitHub errors are already safe; anything else is redacted. */
const safeError = (err: unknown) =>
  err instanceof GitHubError ? err.message : `Something went wrong: ${redact(err instanceof Error ? err.message : String(err))}`;

// ---------- refreshing ----------

/** Whether `owner` is a user or an organization, cached for as long as the token stays the same. */
async function ownerTypeFor(token: string, owner: string, signal?: AbortSignal) {
  const key = owner.toLowerCase();
  const cached = ownerTypes.get(key);
  if (cached) return cached;
  const type = await getOwnerType(token, owner, signal);
  ownerTypes.set(key, type);
  return type;
}

/** Set from GitHub's reset time after a rate limit; no refresh of any kind is sent before it. */
let rateLimitedUntil = 0;
let lastRefreshStartedAt = 0;
let refreshInFlight: Promise<void> | null = null;
/** Aborts the refresh in flight (superseded, token removed, or no longer wanted). */
let refreshController: AbortController | null = null;
/** A forced refresh asked for while another was running: it runs once that one has stopped. */
let refreshQueued = false;
/** A forced refresh waiting out FORCED_MIN_GAP_MS. */
let forcedRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Stop any refresh in progress and anything queued (used when the token is removed). */
function cancelRefresh() {
  refreshQueued = false;
  if (forcedRefreshTimer) clearTimeout(forcedRefreshTimer);
  forcedRefreshTimer = null;
  refreshController?.abort();
}

/**
 * Fetch and push fresh numbers.
 * - Manual refreshes are limited to one per 30 seconds; a refresh already running is reused.
 * - `force` (new settings or a new token) skips that cooldown, but is still spaced 5 s apart, and it
 *   cancels a refresh still running for the old settings, then runs once that has stopped.
 * - After GitHub rate-limits, nothing at all is sent until GitHub's reset time.
 */
function refresh(force = false): void {
  if (refreshInFlight) {
    if (force) {
      refreshQueued = true;
      refreshController?.abort(); // its numbers would be for the old settings or token
    }
    return;
  }
  const token = loadToken();
  const settings = prefs.settings;
  const tracked = trackedWindow();
  if (!token || !settings || !tracked) return;
  const now = Date.now();
  if (now < rateLimitedUntil) {
    send(IPC.result, { ok: false, error: rateLimitMessage(rateLimitedUntil) });
    return;
  }
  if (!force && now < refreshAvailableAt) return;
  if (force && now - lastRefreshStartedAt < FORCED_MIN_GAP_MS) {
    if (forcedRefreshTimer) clearTimeout(forcedRefreshTimer);
    forcedRefreshTimer = setTimeout(() => {
      forcedRefreshTimer = null;
      refresh(true);
    }, FORCED_MIN_GAP_MS - (now - lastRefreshStartedAt));
    return;
  }

  lastRefreshStartedAt = now;
  refreshAvailableAt = now + REFRESH_COOLDOWN_MS;
  // Captured now: if the view or settings change mid-fetch, this refresh is cancelled and run again.
  const isTracked = viewing.kind === 'tracked';
  const window = viewWindow(viewing, tracked, today());
  lastTrackedWindow = tracked;
  const abortController = new AbortController();
  refreshController = abortController;
  pushState();
  refreshInFlight = (async () => {
    send(IPC.loading, true);
    try {
      const ownerType = await ownerTypeFor(token, settings.owner, abortController.signal);
      if (isTracked) await finalizeEndedPeriod(token, settings, tracked, ownerType, abortController.signal);
      const metrics = await getMetrics(token, settings, window, ownerType, timezone, abortController.signal);
      if (abortController.signal.aborted) return;
      lastShownMetrics = metrics;
      if (isTracked) {
        lastTrackedMetrics = metrics;
        updateTray();
        updateHistory(recordCurrent(history, settings, metrics));
      }
      send(IPC.result, { ok: true, metrics });
    } catch (err) {
      if (abortController.signal.aborted || err instanceof CancelledError) return; // superseded: nothing to report
      if (err instanceof GitHubError && err.retryAt) {
        rateLimitedUntil = err.retryAt;
        refreshAvailableAt = Math.max(refreshAvailableAt, err.retryAt);
      }
      send(IPC.result, { ok: false, error: safeError(err) });
    } finally {
      send(IPC.loading, false);
    }
  })().finally(() => {
    refreshInFlight = null;
    refreshController = null;
    pushState();
    if (refreshQueued) {
      refreshQueued = false;
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
  settings: TrackedSettings,
  tracked: DateWindow,
  ownerType: OwnerType,
  signal: AbortSignal,
) {
  const ended = pendingFinalize(history, settings, tracked);
  if (!ended || historyReadOnly) return;
  const key = periodKey(ended);
  if (finalizeFailed.has(key)) return;
  try {
    const { partners, ...counts } = await getPeriodCounts(token, settings, ended, ownerType, timezone, signal);
    if (signal.aborted) return;
    const extras = partnerExtras(partners, rememberPartnersFor(settings));
    const finalPeriod = { from: ended.from, to: ended.to, ...counts, ...extras, final: true };
    updateHistory(recordPeriod(history, settings, finalPeriod, new Date().toISOString()));
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
  const justAfterMidnight = new Date(now);
  justAfterMidnight.setHours(24, 0, 5, 0); // a few seconds past midnight, local time
  midnightTimer = setTimeout(() => {
    checkRollover();
    scheduleMidnightCheck();
  }, justAfterMidnight.getTime() - now.getTime());
}

// ---------- tray and panel ----------

/** The tray shows the tracked range's standing (never a temporary view): a coloured dot and a tooltip. */
function updateTray() {
  const metrics = lastTrackedMetrics;
  if (!metrics) {
    tray.setImage(trayImage(icon, 'none'));
    tray.setToolTip('IO2');
    return;
  }
  const ratio = reviewRatio(metrics.reviewed.count, metrics.authored.count, superMinReviews(windowDays(metrics.window)));
  tray.setImage(trayImage(icon, ratio.status));
  tray.setToolTip(`IO2 · ratio ${ratio.display} · ${ratio.label}`);
}

function setScreen(next: Screen) {
  // Only show screens that make sense: metrics needs both a token and settings.
  if (!loadToken()) currentScreen = 'token';
  else if (next === 'metrics' && !prefs.settings) currentScreen = 'start';
  else currentScreen = next;
  pushState();
}

let lastHiddenAt = 0;
function hidePanel() {
  if (panel.isVisible()) {
    panel.hide();
    lastHiddenAt = Date.now();
  }
}

/** Shows the panel where it was pinned (if that's still on a screen), else next to the tray icon. */
function showPanel() {
  checkRollover();
  const pinnedAt = prefs.pinned ? visibleBounds(prefs.pinnedBounds) : null;
  if (pinnedAt) panel.setBounds(pinnedAt);
  else placeNearTray(panel, tray);
  panel.show();
  panel.focus();
}

function togglePanel() {
  if (panel.isVisible()) return hidePanel();
  // Clicking the tray icon first blurs (and so hides) an open panel; don't immediately reopen it.
  if (Date.now() - lastHiddenAt < REOPEN_GUARD_MS) return;
  showPanel();
}

function setPinned(pinned: boolean) {
  panel.setAlwaysOnTop(pinned, 'floating');
  updatePrefs({ pinned, pinnedBounds: pinned ? panel.getBounds() : prefs.pinnedBounds });
  if (!pinned) placeNearTray(panel, tray);
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

/** The tray's right-click menu, rebuilt whenever state changes so its checkboxes stay current. */
function rebuildTrayMenu() {
  if (!tray) return;
  const appState = state();
  const themeItem = (label: string, value: Theme) => ({
    label,
    type: 'radio' as const,
    checked: prefs.theme === value,
    click: () => setTheme(value),
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Open IO2', click: showPanel },
    { label: 'Refresh', enabled: appState.hasToken && !!appState.settings, click: () => refresh() },
    { type: 'separator' },
    { label: 'Change range…', enabled: appState.hasToken, click: () => (setScreen('start'), showPanel()) },
    { label: 'Change token…', click: () => (setScreen('token'), showPanel()) },
    { type: 'separator' },
    { label: 'Theme', submenu: [themeItem('System', 'system'), themeItem('Light', 'light'), themeItem('Dark', 'dark')] },
    { label: 'Pin panel', type: 'checkbox', checked: prefs.pinned, click: (item) => setPinned(item.checked) },
    {
      label: app.isPackaged ? 'Start at login' : 'Start at login (installed app only)',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: appState.openAtLogin,
      click: (item) => setOpenAtLogin(item.checked),
    },
    {
      label: 'Remember teammates in history',
      type: 'checkbox',
      checked: prefs.rememberTeammates,
      // It asks first, in a dialog over the panel.
      click: (item) => (showPanel(), void setRememberTeammates(item.checked)),
    },
    { type: 'separator' },
    { label: 'Quit IO2', click: () => app.quit() },
  ]);
  tray.removeAllListeners('right-click');
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

// ---------- IPC: every handler checks the sender, then the payload ----------

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
/** ipcMain.handle, but only for our own page: anything else is rejected before `handler` runs. */
function handleTrusted(channel: string, handler: InvokeHandler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('Rejected IPC from an unknown sender.');
    return handler(event, ...args);
  });
}
/** ipcMain.on, but only for our own page: anything else is silently ignored. */
function onTrusted(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromOurPage(event)) listener(event, ...args);
  });
}

/** `value` if it's a string of at most `maxLength` characters, else null. */
const boundedString = (value: unknown, maxLength: number) => (typeof value === 'string' && value.length <= maxLength ? value : null);

/** Runs a native dialog without the panel hiding itself (and so its dialog) when focus moves to it. */
async function withDialog<T>(showDialog: () => Promise<T>): Promise<T> {
  dialogOpen = true;
  try {
    return await showDialog();
  } finally {
    dialogOpen = false;
  }
}
/**
 * The opt-in to keep teammates' logins in history. Both ways ask first: switching on explains exactly
 * what's kept; switching off deletes every stored login (the anonymous counts stay).
 */
async function setRememberTeammates(enabled: boolean) {
  if (enabled === prefs.rememberTeammates) return pushState();
  const me = viewerLogin ? `@${viewerLogin}` : 'you';
  const { response } = await withDialog(() =>
    dialog.showMessageBox(panel, {
      type: enabled ? 'question' : 'warning',
      buttons: enabled ? ['Remember teammates', 'Cancel'] : ['Forget teammates', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: enabled ? 'Remember teammates in history?' : 'Stop remembering teammates?',
      detail: enabled
        ? `For each period, History will also keep the GitHub usernames of the ${MAX_STORED_PARTNERS} people you traded the most reviews with, and how many, so recaps can name them. ` +
          `It's only recorded while the GitHub user is ${me}, it's kept only on this computer, and it's never included in Export history. Switching this off deletes every stored username.\n\n` +
          "This keeps a record about other people. Whether that's appropriate is your choice: check that it fits your team's expectations and your organization's policies."
        : 'This deletes every stored teammate username from History, including archived periods. The counts stay. It can’t be undone.',
    }),
  );
  const confirmed = response === 0;
  if (confirmed) {
    updatePrefs({ rememberTeammates: enabled });
    if (!enabled) updateHistory(forgetPartners(history));
    // Fill in the current period straight away from the numbers already fetched.
    else if (lastTrackedMetrics && prefs.settings && sameWindow(lastTrackedMetrics.window, trackedWindow())) {
      updateHistory(recordCurrent(history, prefs.settings, lastTrackedMetrics));
    }
  }
  pushState(); // also resets the tray checkbox if this was cancelled
}

const isScreen = (value: unknown): value is Screen => value === 'token' || value === 'start' || value === 'metrics';
const isTheme = (value: unknown): value is Theme => value === 'system' || value === 'light' || value === 'dark';

function registerIpc() {
  handleTrusted(IPC.getState, () => state());

  handleTrusted(IPC.saveToken, async (_event, raw): Promise<ActionResult> => {
    const input = boundedString(raw, MAX_TOKEN_INPUT_LENGTH);
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
    setScreen(prefs.settings ? 'metrics' : 'start');
    if (prefs.settings) refresh(true);
    return { ok: true };
  });

  handleTrusted(IPC.clearToken, async () => {
    cancelRefresh(); // a refresh in progress must not keep using the removed token
    await clearToken();
    viewerLogin = null;
    ownerTypes.clear();
    lastTrackedMetrics = null;
    lastShownMetrics = null;
    updateTray();
    setScreen('token');
  });

  handleTrusted(IPC.start, async (_event, raw): Promise<StartResult> => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid request.' };
    const request = raw as Record<string, unknown>;
    const owner = boundedString(request.owner, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const login = boundedString(request.login, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const labelsInput = boundedString(request.ignoreLabels, MAX_LABELS_INPUT_LENGTH);
    const choice = request.historyChoice === 'archive' || request.historyChoice === 'delete' ? request.historyChoice : null;
    if (!isValidLogin(owner)) return { ok: false, error: 'Enter a valid GitHub username or organization for "Where".' };
    if (!isValidLogin(login)) return { ok: false, error: 'Enter a valid GitHub username.' };
    const range = validRange({ kind: boundedString(request.kind, MAX_RANGE_KIND_LENGTH), start: boundedString(request.start, DATE_LENGTH) });
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
    const settings: TrackedSettings = { owner, login, range, ignoreLabels: labels };
    // A new owner, person, range or start date with history behind it: ask before archiving or deleting it.
    const pendingChoice = historyReadOnly ? null : needsChoice(history, settings);
    if (pendingChoice && !choice) return { ok: false, historyChoice: pendingChoice };
    updateHistory(switchSeries(history, settings, choice ?? 'archive', new Date().toISOString()));
    cancelRefresh(); // anything running belongs to the old settings
    updatePrefs({ settings });
    viewing = TRACKED;
    lastTrackedMetrics = null;
    lastShownMetrics = null;
    updateTray();
    setScreen('metrics');
    refresh(true);
    return { ok: true };
  });

  handleTrusted(IPC.setViewing, (_event, raw): ActionResult => {
    const parsed = parseView(raw);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    viewing = parsed;
    pushState();
    if (parsed.kind === 'tracked' && lastTrackedMetrics && sameWindow(lastTrackedMetrics.window, trackedWindow())) {
      // Back to my range: show the numbers already fetched straight away; refresh only if the cooldown allows.
      refreshController?.abort(); // a fetch still running for the temporary view is no longer wanted
      lastShownMetrics = lastTrackedMetrics;
      send(IPC.result, { ok: true, metrics: lastTrackedMetrics });
      refresh();
    } else {
      refresh(true);
    }
    return { ok: true };
  });

  handleTrusted(IPC.exportHistory, async (): Promise<ActionResult> => {
    const result = await withDialog(() =>
      dialog.showSaveDialog(panel, {
        title: 'Export review history',
        defaultPath: join(app.getPath('documents'), `io2-history-${today()}.csv`),
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

  handleTrusted(IPC.clearHistory, async () => {
    if (historyReadOnly) return;
    const { response } = await withDialog(() =>
      dialog.showMessageBox(panel, {
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
    // Start the current period again from the numbers on screen.
    if (lastTrackedMetrics && prefs.settings) next = recordCurrent(next, prefs.settings, lastTrackedMetrics);
    updateHistory(next);
    pushState();
  });

  onTrusted(IPC.showView, (_event, value) => {
    if (isScreen(value)) setScreen(value);
  });
  onTrusted(IPC.refresh, () => refresh());
  onTrusted(IPC.setTheme, (_event, value) => {
    if (isTheme(value)) setTheme(value);
  });
  onTrusted(IPC.setPinned, (_event, pinned) => {
    if (typeof pinned === 'boolean') setPinned(pinned);
  });
  onTrusted(IPC.setOpenAtLogin, (_event, openAtLogin) => {
    if (typeof openAtLogin === 'boolean') setOpenAtLogin(openAtLogin);
  });
  onTrusted(IPC.setPrView, (_event, value) => {
    const prView = parsePrView(value);
    if (prView) {
      updatePrefs({ prView });
      pushState();
    }
  });
  // No arguments: the text is built here from the numbers this process fetched, never sent by the window.
  handleTrusted(IPC.copyYourPrs, (): ActionResult => {
    const text = prLinksText(lastShownMetrics?.yourPrsWaiting.prs ?? []);
    if (!text) return { ok: false, error: 'There are no PRs to copy.' };
    clipboard.writeText(text);
    return { ok: true };
  });
  handleTrusted(IPC.setRememberTeammates, async (_event, enabled) => {
    if (typeof enabled === 'boolean') await setRememberTeammates(enabled);
  });
  onTrusted(IPC.setRecapSeen, (_event, key) => {
    // Only a period that's actually in the active history.
    const active = historyView(history, historyReadOnly, prefs.settings).active;
    if (isPeriodKey(key) && active?.periods.some((period) => periodKey(period) === key)) {
      updatePrefs({ recapSeen: key });
      pushState();
    }
  });
  onTrusted(IPC.openExternal, (_event, url) => {
    const link = boundedString(url, MAX_URL_LENGTH);
    if (link) openExternalSafely(link);
  });
  onTrusted(IPC.hide, hidePanel);
  onTrusted(IPC.quit, () => app.quit());
}

// ---------- startup ----------

async function start() {
  if (process.platform === 'darwin') app.dock?.hide(); // menu-bar app: no Dock icon

  Menu.setApplicationMenu(null); // no default menu, so no built-in shortcuts such as reload
  serveRenderer(join(distDir, 'renderer'));
  hardenSession();
  installTransport();
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
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

  panel = createPanel(join(distDir, 'preload.cjs'), icon);
  panel.setAlwaysOnTop(prefs.pinned, 'floating');
  panel.on('blur', () => {
    if (!prefs.pinned && !dialogOpen) hidePanel();
  });
  panel.on('moved', () => {
    if (prefs.pinned) updatePrefs({ pinnedBounds: panel.getBounds() });
  });
  // Closing only hides the panel; the app keeps running in the tray until Quit.
  panel.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePanel();
    }
  });
  panel.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !prefs.pinned) hidePanel();
  });

  const token = loadToken();
  currentScreen = !token ? 'token' : prefs.settings ? 'metrics' : 'start';
  rebuildTrayMenu();

  // Open the panel on a normal launch; stay in the tray when started at login.
  const startedAtLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  panel.once('ready-to-show', () => {
    if (!startedAtLogin) showPanel();
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
  if (panel) showPanel();
});
app.on('before-quit', () => {
  quitting = true;
});
// A tray app: no windows being open is normal, so don't quit.
app.on('window-all-closed', () => undefined);
