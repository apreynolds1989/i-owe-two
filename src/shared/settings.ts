// Checks saved settings, and converts settings saved by 0.1.x (fixed from/to dates) to a tracked range.
// Kept free of Electron so scripts/check.ts can test it.
import { parseWindow } from './dateWindow';
import { validRange, windowDays, type RangeSetting } from './range';
import type { TrackedSettings } from './types';
import { isObject, isValidLogin, parseLabels } from './validate';

/** 0.1.x saved a fixed window: a 7-day one becomes Week, anything else Two weeks, both starting on its first day. */
function fromOldWindow(from: unknown, to: unknown): RangeSetting | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const window = parseWindow(from, to);
  if ('error' in window) return null;
  return validRange({ kind: windowDays(window) === 7 ? 'week' : 'twoWeeks', start: window.from });
}

/** Settings as stored, accepted only if every field is still valid. */
export function validSettings(value: unknown): TrackedSettings | null {
  if (!isObject(value)) return null;
  const { owner, login, ignoreLabels } = value;
  if (typeof owner !== 'string' || !isValidLogin(owner)) return null;
  if (typeof login !== 'string' || !isValidLogin(login)) return null;
  const range = validRange(value.range) ?? fromOldWindow(value.from, value.to);
  if (!range) return null;
  if (!Array.isArray(ignoreLabels) || !ignoreLabels.every((label) => typeof label === 'string')) return null;
  const labels = parseLabels(ignoreLabels.join(','));
  if (!Array.isArray(labels)) return null;
  return { owner, login, range, ignoreLabels: labels };
}
