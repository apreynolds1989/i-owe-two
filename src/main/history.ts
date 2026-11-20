// Reads and writes history.json in the app's user-data folder. The rules live in src/shared/history.ts;
// this file only touches the disk. Like prefs.json, it's re-validated on every load, and it's deleted
// with the rest of the app's data on uninstall.
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_HISTORY, historyCsv, parseHistory, type History } from '../shared/history';

const file = () => join(app.getPath('userData'), 'history.json');

export function loadHistory(): { history: History; readOnly: boolean } {
  try {
    return parseHistory(JSON.parse(readFileSync(file(), 'utf8')) as unknown);
  } catch {
    // Missing or unreadable: start empty (a broken file is replaced on the next save).
    return { history: EMPTY_HISTORY, readOnly: false };
  }
}

export function saveHistory(history: History): void {
  try {
    writeFileSync(file(), JSON.stringify(history, null, 2), { mode: 0o600 });
  } catch {
    // Not worth failing over: the numbers on screen are unaffected.
  }
}

/** Writes the CSV export to a path the person chose in the save dialog. Throws if it can't. */
export function exportHistory(history: History, path: string): void {
  writeFileSync(path, historyCsv(history), { encoding: 'utf8' });
}
