// How the "Need reviewers" list is shown: sort direction, grouping by repo and a label filter.
// Pure functions, shared by the main process (which validates and stores the view) and the UI (which
// applies it), and tested by scripts/check.ts.
import type { PrListView, PrSummary } from './types';
import { isObject, parseLabels } from './validate';

export const DEFAULT_PR_VIEW: PrListView = { groupByRepo: false, sort: 'oldest', labels: [] };

/**
 * A view from IPC or prefs.json, accepted only if every field is valid (else null). Labels go through
 * the same rules as the ignore list (count, length, printable), so they come back lower-cased.
 */
export function parsePrView(value: unknown): PrListView | null {
  if (!isObject(value)) return null;
  const { groupByRepo, sort, labels } = value;
  if (typeof groupByRepo !== 'boolean') return null;
  if (sort !== 'oldest' && sort !== 'newest') return null;
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === 'string')) return null;
  // A comma inside one label would be split by parseLabels into two; GitHub labels can contain commas,
  // but the ignore list already can't express those either, so refuse rather than silently change it.
  if (labels.some((label: string) => label.includes(','))) return null;
  const parsed = parseLabels(labels.join(','));
  if (!Array.isArray(parsed)) return null;
  return { groupByRepo, sort, labels: parsed };
}

export interface PrGroup {
  /** Repo name (owner/name) when grouped; null for the single ungrouped list. */
  repo: string | null;
  prs: PrSummary[];
}

const lowerCaseLabels = (pr: PrSummary) => (pr.labels ?? []).map((label) => label.toLowerCase());

/** Filter (any selected label, case-insensitive), sort by creation time, then optionally group by repo. */
export function applyPrView(prs: readonly PrSummary[], view: PrListView): { groups: PrGroup[]; shown: number } {
  const wanted = new Set(view.labels);
  const direction = view.sort === 'oldest' ? 1 : -1;
  const sorted = prs
    .filter((pr) => wanted.size === 0 || lowerCaseLabels(pr).some((label) => wanted.has(label)))
    .sort(
      (a, b) =>
        direction * a.createdAt.localeCompare(b.createdAt) ||
        a.repo.localeCompare(b.repo) ||
        direction * (a.number - b.number),
    );
  if (!view.groupByRepo) return { groups: [{ repo: null, prs: sorted }], shown: sorted.length };

  // Map keeps first-seen order; groups are then ordered by repo name, PRs keep the sorted order.
  const byRepo = new Map<string, PrSummary[]>();
  for (const pr of sorted) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  const groups = [...byRepo].map(([repo, repoPrs]) => ({ repo, prs: repoPrs })).sort((a, b) => a.repo.localeCompare(b.repo));
  return { groups, shown: sorted.length };
}

/**
 * Labels to offer in the filter: every label on these PRs plus any already selected (so a saved filter
 * stays visible, and can be cleared, even when no PR currently carries it). Lower-cased, sorted.
 */
export function labelOptions(prs: readonly PrSummary[], selected: readonly string[]): string[] {
  return [...new Set([...prs.flatMap(lowerCaseLabels), ...selected])].sort((a, b) => a.localeCompare(b));
}
