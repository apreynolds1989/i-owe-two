// The expanded "Waiting on you" card: two sections, so what's explicitly asked of you stands apart from
// PRs you're already part of. The main process decides the sections (splitWaiting in src/main/rules.ts);
// a PR is only ever in one. This component only keeps which sections are collapsed (not remembered).
import type { PrSummary } from '../shared/types';
import { useToggleSet } from './hooks';
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

/** The "Waiting on you" PRs in their Requested and Involved sections, each collapsible. */
export function WaitingList({ prs }: { prs: PrSummary[] }) {
  const [collapsedSections, toggleSection] = useToggleSet();

  return (
    <div className="pr-view">
      {SECTIONS.map(({ key, title, hint }) => {
        const sectionPrs = prs.filter((pr) => (pr.section ?? 'requested') === key);
        if (sectionPrs.length === 0) return null; // an empty section is just noise
        const open = !collapsedSections.has(key);
        return (
          <section key={key} className="pr-group pr-section">
            <button className="pr-group-head" onClick={() => toggleSection(key)} aria-expanded={open} title={hint}>
              <ChevronIcon open={open} />
              <span className="pr-group-name">{title}</span>
              <span className="pr-group-count">{sectionPrs.length}</span>
            </button>
            {open && (
              <ul className="pr-list">
                {sectionPrs.map((pr) => (
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
