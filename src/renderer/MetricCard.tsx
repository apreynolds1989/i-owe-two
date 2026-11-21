// One metric card (count, hint, expandable PR list), and PrRow, the PR line every list uses.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { REVIEWERS_NEEDED } from '../shared/ratio';
import type { Metric, PrSummary } from '../shared/types';
import { openedAgo } from './dates';
import { ChevronIcon } from './icons';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const COUNT_UP_MS = 600;

/** Counts from the previous value to the new one over ~0.6 s (instantly if reduced motion is on). */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  /** The value the last animation finished on: where the next one starts. */
  const settledValue = useRef(target ?? 0);
  useEffect(() => {
    if (target === undefined) return;
    if (prefersReducedMotion()) {
      setShown(target);
      settledValue.current = target;
      return;
    }
    const startedAt = performance.now();
    const startValue = settledValue.current;
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / COUNT_UP_MS);
      const eased = 1 - (1 - progress) ** 3; // ease-out cubic: fast, then settling
      setShown(Math.round(startValue + (target - startValue) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
      else settledValue.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/** A small status pill shown before a PR's details, e.g. "Changes requested". */
export interface PrTag {
  text: string;
  tone: 'neutral' | 'warn';
}

/**
 * One PR in a list: repo#number badge and title (opens on GitHub), optionally who opened it and its
 * reviewer count. `hideRepo` drops the repo from the badge when a group header already names it.
 */
export function PrRow(props: { pr: PrSummary; showReviewers: boolean; hideRepo?: boolean; tag?: PrTag }) {
  const { pr, showReviewers, hideRepo = false, tag } = props;
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
          {tag && <span className={`pr-tag ${tag.tone}`}>{tag.text}</span>}
          {/* Each piece stays whole, so a long line wraps between pieces, never inside "1 of 2 reviewers". */}
          <span className="nowrap">by {pr.author}</span> ·{' '}
          {/* "opened", not "waiting": a PR that started as a draft wasn't waiting the whole time. */}
          <span className="nowrap">{openedAgo(pr.createdAt)}</span> ·{' '}
          <span className="nowrap">
            {pr.reviewerCount ?? 0}
            {` of ${REVIEWERS_NEEDED} reviewers`}
          </span>
        </span>
      )}
    </li>
  );
}

/** A metric's count with its icon and label; when expanded, its PRs (or `children`, for cards with their own layout). */
export function MetricCard(props: {
  icon: ReactNode;
  label: string;
  hint: string;
  metric: Metric | undefined;
  showReviewers: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** A short line under the label, e.g. "2 requested · 3 involved". */
  note?: string;
  /** Replaces the plain PR list when expanded (cards with sections or controls bring their own). */
  children?: ReactNode;
}) {
  const { icon, label, hint, metric, showReviewers, expanded, onToggle, note, children } = props;
  const shown = useCountUp(metric?.count);
  const hasPrs = !!metric && metric.prs.length > 0;

  return (
    <section className={`metric-card${expanded ? ' expanded' : ''}`}>
      <button className="metric-head" onClick={onToggle} disabled={!hasPrs} title={hint} aria-expanded={expanded}>
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">
          {label}
          {note && <span className="metric-note">{note}</span>}
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
