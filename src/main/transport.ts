// How requests reach GitHub: Electron's network stack (Chromium) on a dedicated, in-memory session.
// - Chromium validates TLS against the operating system's certificate store and ignores Node's
//   NODE_TLS_REJECT_UNAUTHORIZED / NODE_EXTRA_CA_CERTS, so an environment variable can't switch off
//   certificate checking and expose the token on a hostile network.
// - The session is separate from the window's, has no cookies or cache on disk, and only lets requests
//   to api.github.com through.
import { session } from 'electron';
import { ENDPOINT, setTransport } from './github';

const API_ORIGIN = new URL(ENDPOINT).origin;

export function installTransport(): void {
  const api = session.fromPartition('github-api', { cache: false }); // no "persist:" prefix: memory only
  api.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  api.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).origin !== API_ORIGIN });
  });
  setTransport((url, init) => {
    if (new URL(url).origin !== API_ORIGIN) return Promise.reject(new Error('Refused a request to a host other than api.github.com.'));
    return api.fetch(url, { ...init, bypassCustomProtocolHandlers: true });
  });
}
