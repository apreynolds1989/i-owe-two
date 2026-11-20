// Remembers non-secret preferences in prefs.json in the app's user-data folder.
// The file is re-validated on every load, so a hand-edited or corrupted file can't feed bad values in.
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PR_VIEW, parsePrView } from '../shared/prView';
import { validSettings } from '../shared/settings';
import type { PrListView, SprintSettings, Theme } from '../shared/types';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Prefs {
  settings: SprintSettings | null;
  theme: Theme;
  pinned: boolean;
  pinnedBounds: Bounds | null;
  prView: PrListView;
}

const DEFAULTS: Prefs = { settings: null, theme: 'system', pinned: false, pinnedBounds: null, prView: DEFAULT_PR_VIEW };
const file = () => join(app.getPath('userData'), 'prefs.json');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validBounds(v: unknown): Bounds | null {
  if (!isObject(v)) return null;
  const { x, y, width, height } = v;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height) ? { x, y, width, height } : null;
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as unknown;
    if (!isObject(raw)) return { ...DEFAULTS };
    return {
      settings: validSettings(raw.settings),
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      pinned: raw.pinned === true,
      pinnedBounds: validBounds(raw.pinnedBounds),
      prView: parsePrView(raw.prView) ?? DEFAULT_PR_VIEW,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    writeFileSync(file(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch {
    // Not worth failing over: the app just starts with defaults next time.
  }
}
