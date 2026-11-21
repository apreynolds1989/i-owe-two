// The History card: the tracked range's past periods (each opens its recap), plus any archived histories.
import { useState } from 'react';
import type { DateWindow } from '../shared/dateWindow';
import { periodKey, periodRatio, type HistoryView, type Period, type Series } from '../shared/history';
import { RANGE_LABELS, sameWindow } from '../shared/range';
import { periodRecap } from '../shared/recap';
import { shortRange } from './dates';
import { ChevronIcon, HistoryIcon } from './icons';
import { RatioChip } from './RatioChip';
import { RecapCard } from './RecapCard';

/**
 * One period: dates, counts and its ratio (judged with the super minimum for its own length). A period
 * that has ended opens its recap; the one in progress has nothing to recap yet.
 */
function PeriodRow({ period, series, current }: { period: Period; series: Series; current: DateWindow | null }) {
  const [open, setOpen] = useState(false);
  const ratio = periodRatio(period);
  const inProgress = sameWindow(period, current);
  const note = inProgress ? 'in progress' : period.final ? null : 'partial';
  const summary = (
    <>
      <span className="history-dates">
        <span>
          {shortRange(period.from, period.to)}
          {note && (
            <span className="history-note" title={note === 'partial' ? 'This period ended before its final numbers could be fetched' : undefined}>
              {' '}
              · {note}
            </span>
          )}
        </span>
        <span className="history-counts">
          {period.reviewed} reviewed · {period.authored} authored
        </span>
      </span>
      <RatioChip ratio={ratio} title={ratio.label} />
    </>
  );
  if (inProgress) return <li className="history-row">{summary}</li>;
  return (
    <li>
      <button className="history-row history-button" onClick={() => setOpen(!open)} aria-expanded={open} title="Show this period’s recap">
        {summary}
      </button>
      {open && <RecapCard recap={periodRecap(series, period)} kind={series.kind} />}
    </li>
  );
}

const newestFirst = (series: Series) => [...series.periods].reverse();
const seriesTitle = (series: Series) =>
  `${RANGE_LABELS[series.kind]} from ${shortRange(series.start, series.start)} · @${series.login} in ${series.owner}`;

/** The tracked range's past periods, plus any archived histories. Read-only; counts are stored on this computer. */
export function HistoryCard({ history, current }: { history: HistoryView; current: DateWindow | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const periods = history.active ? newestFirst(history.active) : [];
  // The last period that has ended, if any; the one in progress is shown in the list.
  const lastEnded = periods.find((period) => !current || period.to < current.from);
  const lastRatio = lastEnded ? periodRatio(lastEnded) : null;
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
              ? 'Saved by a newer version of IO2'
              : lastEnded
                ? `Last period: ${shortRange(lastEnded.from, lastEnded.to)}`
                : 'Builds up as your range rolls over'}
          </span>
        </span>
        {lastRatio && <RatioChip ratio={lastRatio} title={lastRatio.label} />}
        <span className="metric-chevron">{(hasAnything || history.readOnly) && <ChevronIcon open={expanded} />}</span>
      </button>
      {expanded && (
        <div className="history-body">
          {history.readOnly && (
            <p className="muted small">
              This history was saved by a newer version of IO2, so this version leaves it alone. Update the app to see it.
            </p>
          )}
          {history.active && periods.length > 0 && (
            <ul className="history-list">
              {periods.map((period) => (
                <PeriodRow key={periodKey(period)} period={period} series={history.active!} current={current} />
              ))}
            </ul>
          )}
          {history.archived.length > 0 && (
            <>
              <button className="link-button archived-toggle" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
                {showArchived ? 'Hide' : 'Show'} archived ({history.archived.length})
              </button>
              {showArchived &&
                history.archived.map((series) => (
                  <div key={`${series.owner}|${series.login}|${series.kind}|${series.start}`} className="archived-series">
                    <p className="archived-title">
                      {seriesTitle(series)}
                      <span className="muted"> · archived {new Date(series.archivedAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </p>
                    <ul className="history-list">
                      {newestFirst(series).map((period) => (
                        <PeriodRow key={periodKey(period)} period={period} series={series} current={null} />
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
