// Review ratio: PRs reviewed ÷ PRs authored in the range. Each PR needs two reviewers, so reviewing
// at least twice as many PRs as you open is your share of the team's review load.

/** Distinct human reviewers a PR needs; below this it shows in "Need reviewers" and "Your PRs waiting". */
export const REVIEWERS_NEEDED = 2;

export const RATIO_SUPER = 4.0;
export const RATIO_TARGET = 2.0;
export const RATIO_WARN = 1.75;
/**
 * Super also needs this many PRs reviewed per 7 days, scaled to the range's length. It's meant to be
 * hard: with only a handful of PRs, 4.0 alone is too easy to hit.
 */
export const SUPER_REVIEWS_PER_WEEK = 30;

/** Reviews needed for super in a range of `days` days (Day 5, Week 30, Two weeks 60, Year 1,565). */
export const superMinReviews = (days: number) => Math.ceil((SUPER_REVIEWS_PER_WEEK * days) / 7);

/**
 * super: 4.0 and up with enough reviews for the range (sparkles). good: target and up (including 4.0+
 * short of the review count). warn: 1.75 up to target. bad: below 1.75.
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

// Judge the rounded value so the color always agrees with the number on screen
// (1.999 shows as "2.00", so it must be green, not yellow).
const rounded = (reviewed: number, authored: number) => Math.round((reviewed / authored) * 100) / 100;
const plural = (count: number, word: string) => `${count} more ${word}${count === 1 ? '' : 's'}`;

/** How many more PRs to review to reach the target (0 when already there, or when nothing was authored). */
export function reviewsToTarget(reviewed: number, authored: number): number {
  if (authored <= 0) return 0;
  // Uses the same rounding as the ratio, so the hint always agrees with the number on screen:
  // start just below the exact answer, then step up (and back down) to the smallest count that rounds to target.
  let extraReviews = Math.max(0, Math.floor(RATIO_TARGET * authored - reviewed) - 1);
  while (rounded(reviewed + extraReviews, authored) < RATIO_TARGET) extraReviews++;
  while (extraReviews > 0 && rounded(reviewed + extraReviews - 1, authored) >= RATIO_TARGET) extraReviews--;
  return extraReviews;
}

/** `minReviews` is superMinReviews() for the range being shown. */
export function reviewRatio(reviewed: number, authored: number, minReviews: number): ReviewRatio {
  if (authored === 0) return { value: null, display: '–', status: 'none', label: LABELS.none };
  const value = rounded(reviewed, authored);
  const display = value.toFixed(2);
  if (value >= RATIO_SUPER) {
    if (reviewed < minReviews) {
      return { value, display, status: 'good', label: `${LABELS.good} · ${plural(minReviews - reviewed, 'review')} to go super` };
    }
    // Picked from the value, not at random, so the message stays put across refreshes until the ratio changes.
    const label = SUPER_MESSAGES[Math.round(value * 100) % SUPER_MESSAGES.length]!;
    return { value, display, status: 'super', label };
  }
  if (value >= RATIO_TARGET) return { value, display, status: 'good', label: LABELS.good };
  const status = value >= RATIO_WARN ? 'warn' : 'bad';
  return { value, display, status, label: `${LABELS[status]} · review ${plural(reviewsToTarget(reviewed, authored), 'PR')}` };
}
