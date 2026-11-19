// Review ratio: PRs reviewed ÷ PRs authored in the sprint. Each PR needs two reviewers, so reviewing
// at least twice as many PRs as you open is your share of the team's review load.

export const RATIO_SUPER = 4.0;
export const RATIO_TARGET = 2.0;
export const RATIO_WARN = 1.75;

/**
 * super: 4.0 and up (sparkles). good: target up to 4.0. warn: 1.75 up to target. bad: below 1.75.
 * none: no PRs authored (nothing to divide by).
 */
export type RatioStatus = 'super' | 'good' | 'warn' | 'bad' | 'none';

export interface ReviewRatio {
  /** Rounded to 2 decimals, or null when you authored nothing. */
  value: number | null;
  display: string;
  status: RatioStatus;
  /** Short status for the banner and tray. At 'super' it's one of SUPER_MESSAGES. */
  label: string;
}

const LABELS: Record<Exclude<RatioStatus, 'super'>, string> = {
  good: 'On target',
  warn: 'Just under target',
  bad: 'Below target',
  none: 'No PRs authored yet',
};

/** Kept short: the banner is narrow, so each one fits on two lines. */
export const SUPER_MESSAGES = [
  'Review machine! The team owes you a coffee ☕',
  'Legendary reviewer unlocked 🏆',
  'Certified review wizard 🧙',
  'Carrying the team, one review at a time 💪',
  'Merge queue hero 🦸',
];

export function reviewRatio(reviewed: number, authored: number): ReviewRatio {
  if (authored === 0) return { value: null, display: '–', status: 'none', label: LABELS.none };
  // Judge the rounded value so the color always agrees with the number on screen
  // (1.999 shows as "2.00", so it must be green, not yellow).
  const value = Math.round((reviewed / authored) * 100) / 100;
  if (value >= RATIO_SUPER) {
    // Picked from the value, not at random, so the message stays put across refreshes until the ratio changes.
    const label = SUPER_MESSAGES[Math.round(value * 100) % SUPER_MESSAGES.length]!;
    return { value, display: value.toFixed(2), status: 'super', label };
  }
  const status = value >= RATIO_TARGET ? 'good' : value >= RATIO_WARN ? 'warn' : 'bad';
  return { value, display: value.toFixed(2), status, label: LABELS[status] };
}
