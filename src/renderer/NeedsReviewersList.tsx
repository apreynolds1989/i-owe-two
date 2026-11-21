// The expanded "Need reviewers" list: a small toolbar (group by repo, oldest/newest, label filter) over
// the PRs. The view is owned by the main process (remembered in prefs.json): every change is sent with
// setPrView and comes back in the pushed AppState, so this component only keeps which groups are collapsed.
import { useRef, useState } from 'react';
import { applyPrView, labelOptions } from '../shared/prView';
import type { PrListView, PrSummary } from '../shared/types';
import { useClickOutside, useToggleSet } from './hooks';
import { ChevronIcon, FilterIcon, GroupIcon, SortIcon } from './icons';
import { PrRow } from './MetricCard';

/** The "Need reviewers" PRs, filtered, sorted and optionally grouped by `view`, with the controls to change it. */
export function NeedsReviewersList({ prs, view }: { prs: PrSummary[]; view: PrListView }) {
  const [collapsedRepos, toggleRepo] = useToggleSet();
  const [labelsOpen, setLabelsOpen] = useState(false);
  const labelsRef = useRef<HTMLDivElement>(null);
  useClickOutside(labelsRef, labelsOpen, () => setLabelsOpen(false));

  // The main process stores the view and pushes it back in AppState, which re-renders this list.
  const updateView = (change: Partial<PrListView>) => window.sprint.setPrView({ ...view, ...change });
  const toggleLabel = (label: string) =>
    updateView({ labels: view.labels.includes(label) ? view.labels.filter((selected) => selected !== label) : [...view.labels, label] });

  const { groups, shown } = applyPrView(prs, view);
  const options = labelOptions(prs, view.labels);
  const filtering = view.labels.length > 0;

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <button
          className={`toggle-chip${view.groupByRepo ? ' active' : ''}`}
          onClick={() => updateView({ groupByRepo: !view.groupByRepo })}
          aria-pressed={view.groupByRepo}
          title="Group by repository"
        >
          <GroupIcon />
          Repo
        </button>
        <button
          className="toggle-chip"
          onClick={() => updateView({ sort: view.sort === 'oldest' ? 'newest' : 'oldest' })}
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
                  <button role="menuitem" onClick={() => (updateView({ labels: [] }), setLabelsOpen(false))}>
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
              <button className="link-button" onClick={() => updateView({ labels: [] })}>
                Clear filter
              </button>
            </>
          )}
        </p>
      )}

      {groups.map(({ repo, prs: groupPrs }) =>
        repo === null ? (
          <ul key="all" className="pr-list">
            {groupPrs.map((pr) => (
              <PrRow key={pr.url} pr={pr} showReviewers />
            ))}
          </ul>
        ) : (
          <section key={repo} className="pr-group">
            <button className="pr-group-head" onClick={() => toggleRepo(repo)} aria-expanded={!collapsedRepos.has(repo)} title={repo}>
              <ChevronIcon open={!collapsedRepos.has(repo)} />
              <span className="pr-group-name">{repo.split('/').pop()}</span>
              <span className="pr-group-count">{groupPrs.length}</span>
            </button>
            {!collapsedRepos.has(repo) && (
              <ul className="pr-list">
                {groupPrs.map((pr) => (
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
