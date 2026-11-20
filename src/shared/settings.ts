// Checks saved settings, and converts settings saved by 0.1.x (fixed from/to dates) to a tracked range.
// Kept free of Electron so scripts/check.ts can test it.
import { parseWindow } from './args';
import { validRange, windowDays, type RangeSetting } from './range';
import type { SprintSettings } from './types';
import { isValidLogin, parseLabels } from './validate';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** 0.1.x saved a fixed window: a 7-day one becomes Week, anything else Two weeks, both starting on its first day. */
function fromOldWindow(from: unknown, to: unknown): RangeSetting | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const w = parseWindow(from, to);
  if ('error' in w) return null;
  return validRange({ kind: windowDays(w) === 7 ? 'week' : 'twoWeeks', start: w.from });
}

/** Settings as stored, accepted only if every field is still valid. */
export function validSettings(v: unknown): SprintSettings | null {
  if (!isObject(v)) return null;
  const { owner, login, ignoreLabels } = v;
  if (typeof owner !== 'string' || !isValidLogin(owner)) return null;
  if (typeof login !== 'string' || !isValidLogin(login)) return null;
  const range = validRange(v.range) ?? fromOldWindow(v.from, v.to);
  if (!range) return null;
  if (!Array.isArray(ignoreLabels) || !ignoreLabels.every((l) => typeof l === 'string')) return null;
  const labels = parseLabels(ignoreLabels.join(','));
  if (!Array.isArray(labels)) return null;
  return { owner, login, range, ignoreLabels: labels };
}
