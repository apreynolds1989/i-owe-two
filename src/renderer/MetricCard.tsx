import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Metric, PrSummary } from '../shared/types';
import { openedAgo } from './dates';
import { ChevronIcon } from './icons';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts from the previous value to the new one over ~0.6 s (instantly if reduced motion is on). */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target === undefined) return;
    if (prefersReducedMotion()) {
      setShown(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const begin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(begin + (target - begin) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/**
 * One PR in a list: repo#number badge and title (opens on GitHub), optionally who opened it and its
 * reviewer count. `hideRepo` drops the repo from the badge when a group header already names it.
 */
export function PrRow({ pr, showReviewers, hideRepo = false }: { pr: PrSummary; showReviewers: boolean; hideRepo?: boolean }) {
  return (
    <li>
      {/* target=_blank is routed by the main process, which only opens https://github.com links. */}
      <a href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
        <span className="pr-badge">
          {hideRepo ? '' : pr.repo.split('/').pop()}#{pr.number}
        </span>
        <span className="pr-title">{pr.title}</span>
      </a>
      {showReviewers && (
        <span className="pr-meta">
          {/* "opened", not "waiting": a PR that started as a draft wasn't waiting the whole time. */}
          by {pr.author} · {openedAgo(pr.createdAt)} · {pr.reviewerCount ?? 0} of 2 reviewers
        </span>
      )}
    </li>
  );
}

export function MetricCard(props: {
  icon: ReactNode;
  label: string;
  hint: string;
  metric: Metric | undefined;
  showReviewers: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Replaces the plain PR list when expanded (the "Need reviewers" card brings its own controls). */
  children?: ReactNode;
}) {
  const { icon, label, hint, metric, showReviewers, expanded, onToggle, children } = props;
  const shown = useCountUp(metric?.count);
  const hasPrs = !!metric && metric.prs.length > 0;

  return (
    <section className={`metric-card${expanded ? ' expanded' : ''}`}>
      <button className="metric-head" onClick={onToggle} disabled={!hasPrs} title={hint} aria-expanded={expanded}>
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">
          {label}
          {metric?.capped && <span className="metric-note">first 1,000 of {metric.searchTotal.toLocaleString()} searched</span>}
        </span>
        <span className="metric-count">{shown ?? '–'}</span>
        <span className="metric-chevron">{hasPrs && <ChevronIcon open={expanded} />}</span>
      </button>
      {expanded &&
        metric &&
        (children ?? (
          <ul className="pr-list">
            {metric.prs.map((pr) => (
              <PrRow key={pr.url} pr={pr} showReviewers={showReviewers} />
            ))}
          </ul>
        ))}
    </section>
  );
}
