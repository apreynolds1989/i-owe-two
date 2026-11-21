// Electron hardening, following Electron's security checklist
// (https://www.electronjs.org/docs/latest/tutorial/security):
// - the UI is served from a private app:// scheme instead of file://
// - the UI can't load or request anything else, ask for permissions, embed webviews or navigate away
// - IPC messages are only accepted from our own page
// - only https://github.com links can be opened, and only in the default browser
import { app, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { allowedGitHubLink } from '../shared/validate';

const SCHEME = 'app';
const HOST = 'sprint';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
export const INDEX_URL = `${APP_ORIGIN}/index.html`;

/**
 * Must be applied to the served HTML as a response header (stronger than the <meta> copy in
 * index.html): scripts and styles only from the app itself, and no network access at all.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // React applies style={...} through the DOM's style object, which CSP allows without permitting inline styles.
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Chromium switches that would undo the transport guarantees if someone launched the app with them
 * (e.g. by editing its login item). Fuses only cover Node's flags, not these:
 * - certificate and DNS overrides could send the token to a forged api.github.com
 * - a net log in "Everything" mode writes the Authorization header to disk
 * - remote debugging opens a DevTools protocol port
 * proxy-server is deliberately absent: corporate networks use it legitimately, and TLS still applies.
 */
const DANGEROUS_SWITCHES = [
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'host-resolver-rules',
  'host-rules',
  'log-net-log',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-allow-origins',
];

/** Call first thing, before app ready: quits if any dangerous Chromium switch was passed. */
export function refuseDangerousSwitches(): void {
  const found = DANGEROUS_SWITCHES.filter((s) => app.commandLine.hasSwitch(s));
  if (found.length) {
    console.error(`[i-owe-two] Refusing to start with unsafe command-line switches: ${found.map((s) => `--${s}`).join(', ')}`);
    // process.exit is synchronous, so nothing after this call in main.ts (lock, whenReady) gets to run.
    process.exit(1);
  }
}

/** Call before app ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves dist/renderer over app://sprint/. Anything outside that folder is refused. Call after ready. */
export function serveRenderer(rendererDir: string): void {
  const root = normalize(rendererDir);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname);
    const full = normalize(join(root, relative));
    // Path traversal guard: the resolved file must sit inside the renderer folder.
    if (!full.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    const type = MIME[extname(full).toLowerCase()];
    if (!type) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(full);
      const headers: Record<string, string> = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Locks down the default session (the only one the app uses). Call after ready. */
export function hardenSession(): void {
  const ses = session.defaultSession;
  // No camera, microphone, notifications, clipboard-read, geolocation... nothing.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Defence in depth behind the CSP: the UI may only load its own files.
  // (GitHub API calls use their own session, 'github-api' in transport.ts, so they don't go through here.)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(`${APP_ORIGIN}/`) || (!app.isPackaged && details.url.startsWith('devtools://'));
    callback({ cancel: !allowed });
  });
}

/** Applied to every web contents the app creates. */
export function hardenWebContents(contents: WebContents): void {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) event.preventDefault();
  });
  contents.on('will-redirect', (event) => event.preventDefault());
  // Links with target=_blank: GitHub links go to the default browser; everything else is dropped.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
}

/** Opens a link in the default browser, but only an allowed GitHub page (see allowedGitHubLink). */
export function openExternalSafely(url: string): void {
  // Open the parsed, normalized form, never the raw string.
  const safe = allowedGitHubLink(url);
  if (safe) void shell.openExternal(safe);
}

/** True only for messages sent by our own page. */
export function fromOurPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return url === INDEX_URL || url.startsWith(`${INDEX_URL}#`) || url.startsWith(`${INDEX_URL}?`);
}
