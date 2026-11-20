// The expanded "Waiting on you" card: two sections, so what's explicitly asked of you stands apart from
// PRs you're already part of. The main process decides the sections (splitWaiting in src/main/rules.ts);
// a PR is only ever in one. This component only keeps which sections are collapsed (not remembered).
import { useState } from 'react';
import type { PrSummary } from '../shared/types';
import { ChevronIcon } from './icons';
import { PrRow, type PrTag } from './MetricCard';

const SECTIONS = [
  {
    key: 'requested',
    title: 'Requested',
    hint: 'Your review, or your team’s, is requested and still pending',
  },
  {
    key: 'involved',
    title: 'Involved',
    hint: 'You commented or requested changes and haven’t approved since',
  },
] as const;

/** What a row's tag says about where you stand on that PR. */
function tagFor(pr: PrSummary): PrTag | undefined {
  // Requested again after you'd already reviewed: GitHub's "re-request review".
  if (pr.section === 'requested') return pr.myReview ? { text: 'Re-requested', tone: 'neutral' } : undefined;
  if (pr.myReview === 'changes_requested') return { text: 'Changes requested', tone: 'warn' };
  if (pr.myReview === 'dismissed') return { text: 'Review dismissed', tone: 'neutral' };
  if (pr.myReview === 'commented') return { text: 'Commented', tone: 'neutral' };
  return undefined;
}

/** "2 requested · 3 involved", leaving out an empty side. */
export function waitingNote(prs: PrSummary[]): string | undefined {
  const requested = prs.filter((pr) => pr.section === 'requested').length;
  const involved = prs.length - requested;
  return [requested && `${requested} requested`, involved && `${involved} involved`].filter(Boolean).join(' · ') || undefined;
}

export function WaitingList({ prs }: { prs: PrSummary[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="pr-view">
      {SECTIONS.map(({ key, title, hint }) => {
        const list = prs.filter((pr) => (pr.section ?? 'requested') === key);
        if (list.length === 0) return null; // an empty section is just noise
        const open = !collapsed.has(key);
        return (
          <section key={key} className="pr-group pr-section">
            <button className="pr-group-head" onClick={() => toggle(key)} aria-expanded={open} title={hint}>
              <ChevronIcon open={open} />
              <span className="pr-group-name">{title}</span>
              <span className="pr-group-count">{list.length}</span>
            </button>
            {open && (
              <ul className="pr-list">
                {list.map((pr) => (
                  <PrRow key={pr.url} pr={pr} showReviewers tag={tagFor(pr)} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
