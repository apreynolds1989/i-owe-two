// Electron main process: owns the tray icon, the panel, the token and every call to GitHub.
// The UI (src/renderer) is sandboxed and can only ask for things through the preload bridge; every
// request is checked here (sender, payload shape, values) before anything happens.
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWindow } from '../shared/args';
import { reviewRatio } from '../shared/ratio';
import { IPC, type ActionResult, type AppState, type SprintMetrics, type SprintSettings, type Theme, type View } from '../shared/types';
import { checkToken, isValidLogin, MAX_LOGIN_LENGTH, parseLabels, redact } from '../shared/validate';
import { CancelledError, GitHubError } from './github';
import { getOwnerType, getSprintMetrics, getViewerLogin } from './metrics';
import { createPanel, createTray, loadIcon, placeNearTray, visibleBounds } from './panel';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { fromOurPage, hardenSession, hardenWebContents, openExternalSafely, registerAppScheme, serveRenderer } from './security';
import { canPersist, clearToken, initToken, loadToken, saveToken } from './token';
import { installTransport } from './transport';

// Bundled to dist/main.js; the renderer, preload and icon are found relative to it.
const distDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(distDir);

const REFRESH_COOLDOWN_MS = 30_000;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------- before the app is ready ----------

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
let view: View = 'start';
let viewerLogin: string | null = null;
const ownerTypes = new Map<string, 'User' | 'Organization'>();
let refreshAvailableAt = 0;
let inFlight: Promise<void> | null = null;
let quitting = false;

let win: BrowserWindow;
let tray: Tray;

function state(): AppState {
  return {
    view,
    hasToken: loadToken() !== null,
    tokenPersisted: canPersist(),
    viewerLogin,
    settings: prefs.settings,
    theme: prefs.theme,
    pinned: prefs.pinned,
    openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    canOpenAtLogin: app.isPackaged,
    refreshAvailableAt,
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
  if (!token || !settings) return;
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
  const ac = new AbortController();
  controller = ac;
  pushState();
  inFlight = (async () => {
    send(IPC.loading, true);
    try {
      const ownerType = await ownerTypeFor(token, settings.owner, ac.signal);
      const metrics = await getSprintMetrics(token, settings, ownerType, timezone, ac.signal);
      if (ac.signal.aborted) return;
      send(IPC.result, { ok: true, metrics });
      updateTooltip(metrics);
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

// ---------- tray and panel ----------

function updateTooltip(m?: SprintMetrics) {
  if (!m) return tray.setToolTip('Sprint Widget');
  const r = reviewRatio(m.reviewed.count, m.authored.count);
  tray.setToolTip(`Sprint Widget · ratio ${r.display} · ${r.label}`);
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
    { label: 'Open Sprint Widget', click: showPanel },
    { label: 'Refresh', enabled: s.hasToken && !!s.settings, click: () => refresh() },
    { type: 'separator' },
    { label: 'Change sprint…', enabled: s.hasToken, click: () => (setView('start'), showPanel()) },
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
    { label: 'Quit Sprint Widget', click: () => app.quit() },
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
    setView('token');
  });

  handle(IPC.start, async (_e, raw): Promise<ActionResult> => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid request.' };
    const r = raw as Record<string, unknown>;
    const owner = str(r.owner, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const login = str(r.login, MAX_LOGIN_LENGTH)?.trim() ?? '';
    const from = str(r.from, 10) ?? '';
    const to = str(r.to, 10) ?? '';
    const labelsInput = str(r.ignoreLabels, 1000);
    if (!isValidLogin(owner)) return { ok: false, error: 'Enter a valid GitHub username or organization for "Where".' };
    if (!isValidLogin(login)) return { ok: false, error: 'Enter a valid GitHub username.' };
    const w = parseWindow(from, to);
    if ('error' in w) return { ok: false, error: w.error };
    const labels = parseLabels(labelsInput ?? '');
    if (!Array.isArray(labels)) return { ok: false, error: labels.error };

    const token = loadToken();
    if (!token) return { ok: false, error: 'Add a token first.' };
    try {
      await ownerTypeFor(token, owner); // fails clearly if the owner doesn't exist
    } catch (err) {
      return { ok: false, error: safeError(err) };
    }
    const settings: SprintSettings = { owner, login, from: w.from, to: w.to, ignoreLabels: labels };
    updatePrefs({ settings });
    setView('metrics');
    refresh(true);
    return { ok: true };
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

  const icon = loadIcon(appDir);
  tray = createTray(icon);
  updateTooltip();
  tray.on('click', togglePanel);

  win = createPanel(join(distDir, 'preload.cjs'), icon);
  win.setAlwaysOnTop(prefs.pinned, 'floating');
  win.on('blur', () => {
    if (!prefs.pinned) hidePanel();
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
