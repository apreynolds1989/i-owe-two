// Keeps the GitHub token. It is encrypted by the operating system (Windows DPAPI, the macOS Keychain)
// before it touches the disk, and it never leaves the main process except in the Authorization
// header sent to GitHub. If the OS can't encrypt it, it's held in memory only, until the app quits.
import { app, safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const tokenFile = () => join(app.getPath('userData'), 'token.bin');
/** The token in use (decrypted), or null. Never leaves this process except in the Authorization header. */
let currentToken: string | null = null;
/** Whether the OS can encrypt the token, so it can be written to disk. */
let persistable = false;

/** Call once after app ready: checks OS encryption and loads a saved token. */
export async function initToken(): Promise<void> {
  persistable =
    (await safeStorage.isAsyncEncryptionAvailable()) &&
    // Linux's plain-text fallback isn't real encryption, so it doesn't count.
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  if (!persistable || !existsSync(tokenFile())) return;
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(tokenFile()));
    currentToken = result;
    // The OS rotated its key: store it again under the new one.
    if (shouldReEncrypt) await writeEncrypted(result);
  } catch {
    // Unreadable (e.g. copied from another account or machine): treat as no token.
    currentToken = null;
  }
}

/** Whether the token is stored encrypted on disk (false means: memory only, until quit). */
export const canPersist = () => persistable;

/** The token in use, or null if there isn't one. */
export const loadToken = () => currentToken;

async function writeEncrypted(token: string) {
  await writeFile(tokenFile(), await safeStorage.encryptStringAsync(token), { mode: 0o600 });
}

/**
 * Saves the token: encrypted on disk when the OS allows (see canPersist), else in memory only.
 * The encrypted write happens first, so a failed write leaves the previous state untouched (it throws).
 */
export async function saveToken(token: string): Promise<void> {
  if (persistable) await writeEncrypted(token);
  currentToken = token;
}

/** Forgets the token and deletes the saved copy, if any. */
export async function clearToken(): Promise<void> {
  currentToken = null;
  await rm(tokenFile(), { force: true });
}
