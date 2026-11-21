// The expanded "Your PRs waiting" card: your own open PRs still short of reviewers, with a Copy button
// to paste the lot into a chat. The main process builds the copied text from its own numbers
// (prLinksText in src/shared/prLinks.ts); this component only shows whether it worked.
import { useEffect, useState } from 'react';
import type { PrSummary } from '../shared/types';
import { CheckIcon, CopyIcon } from './icons';
import { PrRow } from './MetricCard';

/** How long "Copied" (or "Nothing to copy") shows before the button goes back to "Copy". */
const COPY_FEEDBACK_MS = 2000;

/** Your open PRs still short of reviewers, with a button to copy them all as links. */
export function YourPrsList({ prs }: { prs: PrSummary[] }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyStatus === 'idle') return;
    const timer = setTimeout(() => setCopyStatus('idle'), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const copy = () => void window.sprint.copyYourPrs().then((result) => setCopyStatus(result.ok ? 'copied' : 'failed'));

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <button
          className={`toggle-chip${copyStatus === 'copied' ? ' active' : ''}`}
          onClick={copy}
          title="Copy every PR here (title and link, one per line) to paste into a chat"
        >
          {copyStatus === 'copied' ? <CheckIcon /> : <CopyIcon />}
          {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Nothing to copy' : `Copy ${prs.length === 1 ? 'link' : `${prs.length} links`}`}
        </button>
      </div>
      <ul className="pr-list">
        {prs.map((pr) => (
          <PrRow key={pr.url} pr={pr} showReviewers />
        ))}
      </ul>
    </div>
  );
}
