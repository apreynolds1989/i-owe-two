// Keeps the GitHub token. It is encrypted by the operating system (Windows DPAPI, the macOS Keychain)
// before it touches the disk, and it never leaves the main process except in the Authorization
// header sent to GitHub. If the OS can't encrypt it, it's held in memory only, until the app quits.
import { app, safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const file = () => join(app.getPath('userData'), 'token.bin');
let memory: string | null = null;
let persistable = false;

/** Call once after app ready: checks OS encryption and loads a saved token. */
export async function initToken(): Promise<void> {
  persistable =
    (await safeStorage.isAsyncEncryptionAvailable()) &&
    // Linux's plain-text fallback isn't real encryption, so it doesn't count.
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  if (!persistable || !existsSync(file())) return;
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(file()));
    memory = result;
    // The OS rotated its key: store it again under the new one.
    if (shouldReEncrypt) await writeEncrypted(result);
  } catch {
    // Unreadable (e.g. copied from another account or machine): treat as no token.
    memory = null;
  }
}

/** Whether the token is stored encrypted on disk (false means: memory only, until quit). */
export const canPersist = () => persistable;

export const loadToken = () => memory;

async function writeEncrypted(token: string) {
  await writeFile(file(), await safeStorage.encryptStringAsync(token), { mode: 0o600 });
}

/**
 * Saves the token; returns whether it was written (encrypted) to disk or only kept in memory.
 * The encrypted write happens first, so a failed write leaves the previous state untouched (it throws).
 */
export async function saveToken(token: string): Promise<{ persisted: boolean }> {
  if (persistable) await writeEncrypted(token);
  memory = token;
  return { persisted: persistable };
}

export async function clearToken(): Promise<void> {
  memory = null;
  await rm(file(), { force: true });
}
