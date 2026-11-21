// The panel: header (refresh, pin, theme, menu, hide), then the current screen (token, start or metrics).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { periodKey } from '../shared/history';
import { RANGE_LABELS, sameWindow } from '../shared/range';
import { REVIEWERS_NEEDED } from '../shared/ratio';
import { pendingRecap, periodRecap } from '../shared/recap';
import { useClickOutside } from './hooks';
import type { ActionResult, AppState, PrListView, ReviewMetrics } from '../shared/types';
import titleDark from '../../assets/title-dark.png';
import titleLight from '../../assets/title-light.png';
import { shortRange } from './dates';
import { HistoryCard } from './HistoryCard';
import {
  CloseIcon, MonitorIcon, MoonIcon, MoreIcon, OutboxIcon, PencilIcon, PinIcon, PullRequestIcon, RefreshIcon, ReviewersIcon,
  ReviewIcon, SunIcon, WaitingIcon,
} from './icons';
import { MetricCard } from './MetricCard';
import { NeedsReviewersList } from './NeedsReviewersList';
import { waitingNote, WaitingList } from './WaitingList';
import { RatioCard } from './RatioCard';
import { RecapCard } from './RecapCard';
import { StartForm } from './StartForm';
import { NEXT_THEME, THEME_LABEL } from './theme';
import { TokenForm } from './TokenForm';
import { ViewingBar } from './ViewingBar';
import { YourPrsList } from './YourPrsList';

/** The metric cards, top to bottom. `showReviewers` adds who opened each PR, when, and its reviewer count. */
const CARDS = [
  { key: 'authored', label: 'Authored', icon: <PullRequestIcon />, hint: 'PRs opened in these dates', showReviewers: false },
  {
    key: 'reviewed',
    label: 'Reviewed',
    icon: <ReviewIcon />,
    hint: "Others' PRs reviewed in these dates (any review state)",
    showReviewers: false,
  },
  {
    key: 'waitingOnYou',
    label: 'Waiting on you',
    icon: <WaitingIcon />,
    hint: 'Open, ready PRs on your plate right now. Requested: your review (or your team’s) is requested and pending. Involved: you commented or requested changes and haven’t approved since.',
    showReviewers: true,
  },
  {
    key: 'yourPrsWaiting',
    label: 'Your PRs waiting',
    icon: <OutboxIcon />,
    hint: `Your open, ready PRs with fewer than ${REVIEWERS_NEEDED} reviewers (right now, whatever the dates)`,
    showReviewers: true,
  },
  {
    key: 'needsReviewers',
    label: 'Need reviewers',
    icon: <ReviewersIcon />,
    hint: `Open, ready PRs with fewer than ${REVIEWERS_NEEDED} reviewers that you haven’t reviewed yet (whole organization or account, right now)`,
    showReviewers: true,
  },
] as const;
type MetricKey = (typeof CARDS)[number]['key'];

/** The cards that bring their own expanded layout; the others show a plain PR list. */
function cardBody(key: MetricKey, metrics: ReviewMetrics, prView: PrListView): ReactNode {
  switch (key) {
    case 'needsReviewers':
      return <NeedsReviewersList prs={metrics.needsReviewers.prs} view={prView} />;
    case 'waitingOnYou':
      return <WaitingList prs={metrics.waitingOnYou.prs} />;
    case 'yourPrsWaiting':
      return <YourPrsList prs={metrics.yourPrsWaiting.prs} />;
    default:
      return undefined;
  }
}

/** "2:42 PM", in this computer's locale. */
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/** "just now", "1 minute ago", "12 minutes ago". */
function minutesAgo(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

/** Seconds until a manual refresh is allowed again (0 when it is). Ticks once a second while waiting. */
function useCooldown(availableAt: number): number {
  // The tick only triggers re-renders; the time is read fresh on each render, so the value is right even
  // when the timer isn't running (e.g. a new cooldown arriving long after the last tick).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (availableAt <= Date.now()) return;
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
      // Stop once the cooldown is over: the last tick renders the 0, and nothing needs to tick after it.
      if (Date.now() >= availableAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [availableAt]);
  return Math.max(0, Math.ceil((availableAt - Date.now()) / 1000));
}

/**
 * The whole panel. State comes from the main process (pushed on every change); this component only keeps
 * the latest numbers, the latest error, and what's open on screen.
 */
export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [metrics, setMetrics] = useState<ReviewMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedCard, setExpandedCard] = useState<MetricKey | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.sprint.getState().then(setState);
    const unsubscribes = [
      window.sprint.onState(setState),
      window.sprint.onLoading(setLoading),
      window.sprint.onResult((result) => {
        if (result.ok) {
          setMetrics(result.metrics);
          setError(null);
        } else {
          setError(result.error); // keep the last good numbers on screen
        }
      }),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, []);

  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false));

  const cooldown = useCooldown(state?.refreshAvailableAt ?? 0);
  if (!state) return <div className="panel" />;

  // Numbers from older settings, or for other dates than the ones on screen, are hidden. Comparing as
  // JSON is safe here: both copies are built by the main process with the same key order.
  const currentMetrics =
    metrics && state.settings && JSON.stringify(metrics.settings) === JSON.stringify(state.settings) && sameWindow(metrics.window, state.window)
      ? metrics
      : null;
  /** A menu action that may fail: its error replaces (or clears) the one on screen. */
  const historyAction = (action: () => Promise<ActionResult>) => () =>
    void action().then((result) => setError(result.ok ? null : result.error));
  const canRefresh = state.view === 'metrics' && !loading && cooldown === 0;
  // The last locked-in period's recap shows by itself until dismissed, but only on your own range.
  const recapPeriod = state.viewing.kind === 'tracked' ? pendingRecap(state.history.active, state.trackedWindow, state.recapSeen) : null;
  const ThemeIcon = state.theme === 'light' ? SunIcon : state.theme === 'dark' ? MoonIcon : MonitorIcon;

  return (
    <div className={`panel${state.pinned ? ' pinned' : ''}`}>
      <header className="header">
        {/* The page follows prefers-color-scheme (driven by the theme choice), so the title swaps without any JS. */}
        <picture className="brand">
          <source media="(prefers-color-scheme: dark)" srcSet={titleDark} />
          <img src={titleLight} alt="IO2" height={30} />
        </picture>
        <div className="header-actions">
          {state.view === 'metrics' && (
            <button
              className={`icon-button${loading ? ' spinning' : ''}`}
              onClick={() => window.sprint.refresh()}
              disabled={!canRefresh}
              title={loading ? 'Refreshing…' : cooldown > 0 ? `Refresh available in ${cooldown}s` : 'Refresh'}
              aria-label="Refresh"
            >
              <RefreshIcon />
            </button>
          )}
          <button
            className={`icon-button${state.pinned ? ' active' : ''}`}
            onClick={() => window.sprint.setPinned(!state.pinned)}
            title={state.pinned ? 'Unpin (hide when clicking away)' : 'Pin (keep open, on top, and draggable)'}
            aria-label={state.pinned ? 'Unpin' : 'Pin'}
            aria-pressed={state.pinned}
          >
            <PinIcon filled={state.pinned} />
          </button>
          <button
            className="icon-button"
            onClick={() => window.sprint.setTheme(NEXT_THEME[state.theme])}
            title={`${THEME_LABEL[state.theme]} (click to change)`}
            aria-label={THEME_LABEL[state.theme]}
          >
            <ThemeIcon />
          </button>
          <div className="menu-anchor" ref={menuRef}>
            <button className="icon-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="More" aria-expanded={menuOpen}>
              <MoreIcon />
            </button>
            {menuOpen && (
              <div className="menu" role="menu" onClick={() => setMenuOpen(false)}>
                {state.hasToken && (
                  <button role="menuitem" onClick={() => window.sprint.showView('start')}>
                    Change range…
                  </button>
                )}
                {state.settings && (
                  <>
                    <button role="menuitem" onClick={historyAction(() => window.sprint.exportHistory())}>
                      Export history…
                    </button>
                    {!state.history.readOnly && (
                      <button role="menuitem" onClick={() => void window.sprint.clearHistory()}>
                        Clear history…
                      </button>
                    )}
                  </>
                )}
                <button role="menuitem" onClick={() => window.sprint.showView('token')}>
                  Change token…
                </button>
                {state.settings && !state.history.readOnly && (
                  <button
                    role="menuitemcheckbox"
                    aria-checked={state.rememberTeammates}
                    onClick={() => void window.sprint.setRememberTeammates(!state.rememberTeammates)}
                    title="Also keep the usernames of the people you trade the most reviews with in History (asks first)"
                  >
                    {state.rememberTeammates ? '✓ ' : ''}Remember teammates in history
                  </button>
                )}
                {state.canOpenAtLogin && (
                  <button role="menuitemcheckbox" aria-checked={state.openAtLogin} onClick={() => window.sprint.setOpenAtLogin(!state.openAtLogin)}>
                    {state.openAtLogin ? '✓ ' : ''}Start at login
                  </button>
                )}
                <hr />
                <button role="menuitem" onClick={() => window.sprint.quit()}>
                  Quit IO2
                </button>
              </div>
            )}
          </div>
          <button className="icon-button" onClick={() => window.sprint.hide()} title="Hide (Esc)" aria-label="Hide">
            <CloseIcon />
          </button>
        </div>
      </header>

      <main className="content">
        {state.view === 'token' && <TokenForm state={state} />}
        {state.view === 'start' && <StartForm key={state.viewerLogin ?? ''} state={state} />}
        {state.view === 'metrics' && state.settings && (
          <>
            <button className="context-chip" onClick={() => window.sprint.showView('start')} title="Change your range">
              <span>{state.settings.owner}</span>
              <span className="dot">·</span>
              <span>{RANGE_LABELS[state.settings.range.kind]}</span>
              {state.trackedWindow && <span>{shortRange(state.trackedWindow.from, state.trackedWindow.to)}</span>}
              <span className="dot">·</span>
              <span>@{state.settings.login}</span>
              <PencilIcon />
            </button>

            <ViewingBar state={state} />

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}

            {recapPeriod && state.history.active && (
              <RecapCard
                recap={periodRecap(state.history.active, recapPeriod)}
                kind={state.history.active.kind}
                title={`${RANGE_LABELS[state.history.active.kind]} recap`}
                onDismiss={() => window.sprint.setRecapSeen(periodKey(recapPeriod))}
              />
            )}

            <RatioCard metrics={currentMetrics} window={state.window} />

            <div className="metric-list">
              {CARDS.map(({ key, label, icon, hint, showReviewers }) => (
                <MetricCard
                  key={key}
                  icon={icon}
                  label={label}
                  hint={hint}
                  metric={currentMetrics?.[key]}
                  showReviewers={showReviewers}
                  expanded={expandedCard === key}
                  onToggle={() => setExpandedCard(expandedCard === key ? null : key)}
                  note={key === 'waitingOnYou' && currentMetrics ? waitingNote(currentMetrics.waitingOnYou.prs) : undefined}
                  children={currentMetrics ? cardBody(key, currentMetrics, state.prView) : undefined}
                />
              ))}
              <HistoryCard history={state.history} current={state.trackedWindow} />
            </div>
          </>
        )}
      </main>

      {state.view === 'metrics' && (
        <footer className="footer">
          {currentMetrics ? (
            <span title={`Updated ${minutesAgo(currentMetrics.fetchedAt)} · times in ${currentMetrics.timezone}`}>
              Updated {clockTime(currentMetrics.fetchedAt)}
            </span>
          ) : (
            <span>{loading ? 'Loading from GitHub…' : error ? 'No numbers yet' : ''}</span>
          )}
          {state.viewerLogin && <span className="muted">signed in as @{state.viewerLogin}</span>}
        </footer>
      )}
    </div>
  );
}
