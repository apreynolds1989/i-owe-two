// The expanded "Need reviewers" list: a small toolbar (group by repo, oldest/newest, label filter) over
// the PRs. The view is owned by the main process (remembered in prefs.json): every change is sent with
// setPrView and comes back in the pushed AppState, so this component only keeps which groups are collapsed.
import { useRef, useState } from 'react';
import { applyPrView, labelOptions } from '../shared/prView';
import type { PrListView, PrSummary } from '../shared/types';
import { useClickOutside } from './hooks';
import { ChevronIcon, FilterIcon, GroupIcon, SortIcon } from './icons';
import { PrRow } from './MetricCard';

export function NeedsReviewersList({ prs, view }: { prs: PrSummary[]; view: PrListView }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const labelsRef = useRef<HTMLDivElement>(null);
  useClickOutside(labelsRef, labelsOpen, () => setLabelsOpen(false));

  const set = (change: Partial<PrListView>) => window.sprint.setPrView({ ...view, ...change });
  const toggleLabel = (label: string) =>
    set({ labels: view.labels.includes(label) ? view.labels.filter((l) => l !== label) : [...view.labels, label] });
  const toggleGroup = (repo: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(repo)) next.add(repo);
      return next;
    });

  const { groups, shown } = applyPrView(prs, view);
  const options = labelOptions(prs, view.labels);
  const filtering = view.labels.length > 0;

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <button
          className={`toggle-chip${view.groupByRepo ? ' active' : ''}`}
          onClick={() => set({ groupByRepo: !view.groupByRepo })}
          aria-pressed={view.groupByRepo}
          title="Group by repository"
        >
          <GroupIcon />
          Repo
        </button>
        <button
          className="toggle-chip"
          onClick={() => set({ sort: view.sort === 'oldest' ? 'newest' : 'oldest' })}
          title={view.sort === 'oldest' ? 'Oldest first (click for newest first)' : 'Newest first (click for oldest first)'}
        >
          <SortIcon descending={view.sort === 'newest'} />
          {view.sort === 'oldest' ? 'Oldest' : 'Newest'}
        </button>
        <div className="menu-anchor" ref={labelsRef}>
          <button
            className={`toggle-chip${filtering ? ' active' : ''}`}
            onClick={() => setLabelsOpen(!labelsOpen)}
            aria-expanded={labelsOpen}
            disabled={options.length === 0}
            title={options.length === 0 ? 'None of these PRs have labels' : 'Show only PRs with any of the chosen labels'}
          >
            <FilterIcon />
            Labels{filtering ? ` (${view.labels.length})` : ''}
          </button>
          {labelsOpen && (
            <div className="menu label-menu" role="menu">
              {options.map((label) => (
                <button
                  key={label}
                  role="menuitemcheckbox"
                  aria-checked={view.labels.includes(label)}
                  onClick={() => toggleLabel(label)}
                >
                  <span className="check">{view.labels.includes(label) ? '✓' : ''}</span>
                  <span className="label-name">{label}</span>
                </button>
              ))}
              {filtering && (
                <>
                  <hr />
                  <button role="menuitem" onClick={() => (set({ labels: [] }), setLabelsOpen(false))}>
                    Clear filter
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {filtering && (
        <p className="pr-view-note">
          Showing {shown} of {prs.length}
          {shown === 0 && (
            <>
              {' · '}
              <button className="link-button" onClick={() => set({ labels: [] })}>
                Clear filter
              </button>
            </>
          )}
        </p>
      )}

      {groups.map(({ repo, prs: list }) =>
        repo === null ? (
          <ul key="all" className="pr-list">
            {list.map((pr) => (
              <PrRow key={pr.url} pr={pr} showReviewers />
            ))}
          </ul>
        ) : (
          <section key={repo} className="pr-group">
            <button className="pr-group-head" onClick={() => toggleGroup(repo)} aria-expanded={!collapsed.has(repo)} title={repo}>
              <ChevronIcon open={!collapsed.has(repo)} />
              <span className="pr-group-name">{repo.split('/').pop()}</span>
              <span className="pr-group-count">{list.length}</span>
            </button>
            {!collapsed.has(repo) && (
              <ul className="pr-list">
                {list.map((pr) => (
                  <PrRow key={pr.url} pr={pr} showReviewers hideRepo />
                ))}
              </ul>
            )}
          </section>
        ),
      )}
    </div>
  );
}
