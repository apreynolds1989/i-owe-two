// Remembers non-secret preferences in prefs.json in the app's user-data folder.
// The file is re-validated on every load, so a hand-edited or corrupted file can't feed bad values in.
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPeriodKey } from '../shared/history';
import { DEFAULT_PR_VIEW, parsePrView } from '../shared/prView';
import { validSettings } from '../shared/settings';
import type { PrListView, Theme, TrackedSettings } from '../shared/types';
import { isObject } from '../shared/validate';
import type { Rect } from './placement';

/** Everything in prefs.json. Field names are the file format: renaming one loses that setting. */
export interface Prefs {
  settings: TrackedSettings | null;
  theme: Theme;
  pinned: boolean;
  /** Where the pinned panel was last dragged to. */
  pinnedBounds: Rect | null;
  prView: PrListView;
  /** Opt-in, off by default: keep teammates' logins in history (see partnerExtras in src/shared/history.ts). */
  rememberTeammates: boolean;
  /** "from|to" of the last period whose recap was dismissed. */
  recapSeen: string | null;
}

const DEFAULTS: Prefs = {
  settings: null, theme: 'system', pinned: false, pinnedBounds: null, prView: DEFAULT_PR_VIEW, rememberTeammates: false, recapSeen: null,
};
const prefsFile = () => join(app.getPath('userData'), 'prefs.json');

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validBounds(value: unknown): Rect | null {
  if (!isObject(value)) return null;
  const { x, y, width, height } = value;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height) ? { x, y, width, height } : null;
}

/** The saved preferences, with defaults for anything missing or invalid (or for a missing or broken file). */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(prefsFile(), 'utf8')) as unknown;
    if (!isObject(raw)) return { ...DEFAULTS };
    return {
      settings: validSettings(raw.settings),
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      pinned: raw.pinned === true,
      pinnedBounds: validBounds(raw.pinnedBounds),
      prView: parsePrView(raw.prView) ?? DEFAULT_PR_VIEW,
      rememberTeammates: raw.rememberTeammates === true,
      recapSeen: isPeriodKey(raw.recapSeen) ? raw.recapSeen : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Writes prefs.json, readable only by this user. A failed write is ignored. */
export function savePrefs(prefs: Prefs): void {
  try {
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch {
    // Not worth failing over: the app just starts with defaults next time.
  }
}
