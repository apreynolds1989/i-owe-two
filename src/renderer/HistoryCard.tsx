import { useState } from 'react';
import type { SprintWindow } from '../shared/args';
import { periodRatio, type HistoryView, type Period, type Series } from '../shared/history';
import { RANGE_LABELS } from '../shared/range';
import { shortRange } from './dates';
import { ChevronIcon, HistoryIcon } from './icons';

/** One period: dates, counts and its ratio (judged with the super minimum for its own length). */
function PeriodRow({ p, current }: { p: Period; current: SprintWindow | null }) {
  const r = periodRatio(p);
  const inProgress = !!current && p.from === current.from && p.to === current.to;
  const note = inProgress ? 'in progress' : p.final ? null : 'partial';
  return (
    <li className="history-row">
      <span className="history-dates">
        <span>
          {shortRange(p.from, p.to)}
          {note && (
            <span className="history-note" title={note === 'partial' ? 'This period ended before its final numbers could be fetched' : undefined}>
              {' '}
              · {note}
            </span>
          )}
        </span>
        <span className="history-counts">
          {p.reviewed} reviewed · {p.authored} authored
        </span>
      </span>
      <span className={`ratio-chip chip-${r.status}`} title={r.label}>
        {r.display}
      </span>
    </li>
  );
}

const newestFirst = (s: Series) => [...s.periods].reverse();
const seriesTitle = (s: Series) => `${RANGE_LABELS[s.kind]} from ${shortRange(s.start, s.start)} · @${s.login} in ${s.owner}`;

/** The tracked range's past periods, plus any archived histories. Read-only; counts are stored on this computer. */
export function HistoryCard({ history, current }: { history: HistoryView; current: SprintWindow | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const periods = history.active ? newestFirst(history.active) : [];
  // The last period that has ended, if any; the one in progress is shown in the list.
  const last = periods.find((p) => !current || p.to < current.from);
  const lastRatio = last ? periodRatio(last) : null;
  const hasAnything = periods.length > 0 || history.archived.length > 0;

  return (
    <section className={`metric-card history-card${expanded ? ' expanded' : ''}`}>
      <button
        className="metric-head"
        onClick={() => setExpanded(!expanded)}
        disabled={!hasAnything && !history.readOnly}
        title="Your range's past periods, kept on this computer (counts only)"
        aria-expanded={expanded}
      >
        <span className="metric-icon">
          <HistoryIcon />
        </span>
        <span className="metric-label">
          History
          <span className="metric-note">
            {history.readOnly
              ? 'Saved by a newer version of ReciPRocity'
              : last
                ? `Last period: ${shortRange(last.from, last.to)}`
                : 'Builds up as your range rolls over'}
          </span>
        </span>
        {lastRatio && (
          <span className={`ratio-chip chip-${lastRatio.status}`} title={lastRatio.label}>
            {lastRatio.display}
          </span>
        )}
        <span className="metric-chevron">{(hasAnything || history.readOnly) && <ChevronIcon open={expanded} />}</span>
      </button>
      {expanded && (
        <div className="history-body">
          {history.readOnly && (
            <p className="muted small">
              This history was saved by a newer version of ReciPRocity, so this version leaves it alone. Update the app to see it.
            </p>
          )}
          {periods.length > 0 && (
            <ul className="history-list">
              {periods.map((p) => (
                <PeriodRow key={`${p.from}|${p.to}`} p={p} current={current} />
              ))}
            </ul>
          )}
          {history.archived.length > 0 && (
            <>
              <button className="link-button archived-toggle" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
                {showArchived ? 'Hide' : 'Show'} archived ({history.archived.length})
              </button>
              {showArchived &&
                history.archived.map((s) => (
                  <div key={`${s.owner}|${s.login}|${s.kind}|${s.start}`} className="archived-series">
                    <p className="archived-title">
                      {seriesTitle(s)}
                      <span className="muted"> · archived {new Date(s.archivedAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </p>
                    <ul className="history-list">
                      {newestFirst(s).map((p) => (
                        <PeriodRow key={`${p.from}|${p.to}`} p={p} current={null} />
                      ))}
                    </ul>
                  </div>
                ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
