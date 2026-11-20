// The expanded "Your PRs waiting" card: your own open PRs still short of reviewers, with a Copy button
// to paste the lot into a chat. The main process builds the copied text from its own numbers
// (prLinksText in src/shared/prLinks.ts); this component only shows whether it worked.
import { useEffect, useState } from 'react';
import type { PrSummary } from '../shared/types';
import { CheckIcon, CopyIcon } from './icons';
import { PrRow } from './MetricCard';

export function YourPrsList({ prs }: { prs: PrSummary[] }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const id = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = () => void window.sprint.copyYourPrs().then((r) => setCopied(r.ok ? 'copied' : 'failed'));

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <button
          className={`toggle-chip${copied === 'copied' ? ' active' : ''}`}
          onClick={copy}
          title="Copy every PR here (title and link, one per line) to paste into a chat"
        >
          {copied === 'copied' ? <CheckIcon /> : <CopyIcon />}
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Nothing to copy' : `Copy ${prs.length === 1 ? 'link' : `${prs.length} links`}`}
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
