// Checks saved settings. Kept free of Electron so scripts/check.ts can test it.
import { validRange } from './range';
import type { TrackedSettings } from './types';
import { isObject, isValidLogin, parseLabels } from './validate';

/** Settings as stored, accepted only if every field is still valid. */
export function validSettings(value: unknown): TrackedSettings | null {
  if (!isObject(value)) return null;
  const { owner, login, ignoreLabels } = value;
  if (typeof owner !== 'string' || !isValidLogin(owner)) return null;
  if (typeof login !== 'string' || !isValidLogin(login)) return null;
  const range = validRange(value.range);
  if (!range) return null;
  if (!Array.isArray(ignoreLabels) || !ignoreLabels.every((label) => typeof label === 'string')) return null;
  const labels = parseLabels(ignoreLabels.join(','));
  if (!Array.isArray(labels)) return null;
  return { owner, login, range, ignoreLabels: labels };
}
