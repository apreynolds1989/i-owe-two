import { useEffect, useRef, useState } from 'react';
import { RANGE_LABELS, sameWindow } from '../shared/range';
import { useClickOutside } from './hooks';
import type { AppState, SprintMetrics } from '../shared/types';
import titleDark from '../../assets/title-dark.png';
import titleLight from '../../assets/title-light.png';
import { shortRange } from './dates';
import { HistoryCard } from './HistoryCard';
import {
  CloseIcon, MonitorIcon, MoonIcon, MoreIcon, PencilIcon, PinIcon, PullRequestIcon, RefreshIcon, ReviewersIcon,
  ReviewIcon, SunIcon, WaitingIcon,
} from './icons';
import { MetricCard } from './MetricCard';
import { NeedsReviewersList } from './NeedsReviewersList';
import { RatioCard } from './RatioCard';
import { StartForm } from './StartForm';
import { NEXT_THEME, THEME_LABEL } from './theme';
import { TokenForm } from './TokenForm';
import { ViewingBar } from './ViewingBar';

type MetricKey = 'authored' | 'reviewed' | 'waitingOnYou' | 'needsReviewers';

const CARDS = [
  { key: 'authored', label: 'Authored', icon: <PullRequestIcon />, hint: 'PRs opened in these dates' },
  { key: 'reviewed', label: 'Reviewed', icon: <ReviewIcon />, hint: "Others' PRs reviewed in these dates (any review state)" },
  {
    key: 'waitingOnYou',
    label: 'Waiting on you',
    icon: <WaitingIcon />,
    hint: 'Open, ready PRs where your review is requested and still pending, right now (GitHub drops a request once you review; team requests can show here too)',
  },
  {
    key: 'needsReviewers',
    label: 'Need reviewers',
    icon: <ReviewersIcon />,
    hint: 'Open, ready PRs with fewer than 2 reviewers (whole organization or account, right now)',
  },
] as const;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return mins < 1 ? 'just now' : mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
}

/** Seconds until a manual refresh is allowed again (0 when it is). Ticks once a second while waiting. */
function useCooldown(availableAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (availableAt <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [availableAt]);
  return Math.max(0, Math.ceil((availableAt - now) / 1000));
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [metrics, setMetrics] = useState<SprintMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<MetricKey | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.sprint.getState().then(setState);
    const offs = [
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
    return () => offs.forEach((off) => off());
  }, []);

  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false));

  const cooldown = useCooldown(state?.refreshAvailableAt ?? 0);
  if (!state) return <div className="panel" />;

  // Numbers from older settings, or for other dates than the ones on screen, are hidden.
  const current =
    metrics && state.settings && JSON.stringify(metrics.settings) === JSON.stringify(state.settings) && sameWindow(metrics.window, state.window)
      ? metrics
      : null;
  const historyAction = (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => () =>
    void action().then((r) => setError(r.ok ? null : r.error));
  const canRefresh = state.view === 'metrics' && !loading && cooldown === 0;
  const ThemeIcon = state.theme === 'light' ? SunIcon : state.theme === 'dark' ? MoonIcon : MonitorIcon;

  return (
    <div className={`panel${state.pinned ? ' pinned' : ''}`}>
      <header className="header">
        {/* The page follows prefers-color-scheme (driven by the theme choice), so the title swaps without any JS. */}
        <picture className="brand">
          <source media="(prefers-color-scheme: dark)" srcSet={titleDark} />
          <img src={titleLight} alt="ReciPRocity" height={30} />
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
                {state.canOpenAtLogin && (
                  <button role="menuitemcheckbox" aria-checked={state.openAtLogin} onClick={() => window.sprint.setOpenAtLogin(!state.openAtLogin)}>
                    {state.openAtLogin ? '✓ ' : ''}Start at login
                  </button>
                )}
                <hr />
                <button role="menuitem" onClick={() => window.sprint.quit()}>
                  Quit ReciPRocity
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

            <RatioCard metrics={current} window={state.window} />

            <div className="metric-list">
              {CARDS.map(({ key, label, icon, hint }) => (
                <MetricCard
                  key={key}
                  icon={icon}
                  label={label}
                  hint={hint}
                  metric={current?.[key]}
                  showReviewers={key === 'needsReviewers' || key === 'waitingOnYou'}
                  expanded={open === key}
                  onToggle={() => setOpen(open === key ? null : key)}
                  children={
                    key === 'needsReviewers' && current ? (
                      <NeedsReviewersList prs={current.needsReviewers.prs} view={state.prView} />
                    ) : undefined
                  }
                />
              ))}
              <HistoryCard history={state.history} current={state.trackedWindow} />
            </div>
          </>
        )}
      </main>

      {state.view === 'metrics' && (
        <footer className="footer">
          {current ? (
            <span title={`Updated ${ago(current.fetchedAt)} · times in ${current.timezone}`}>Updated {clock(current.fetchedAt)}</span>
          ) : (
            <span>{loading ? 'Loading from GitHub…' : error ? 'No numbers yet' : ''}</span>
          )}
          {state.viewerLogin && <span className="muted">signed in as @{state.viewerLogin}</span>}
        </footer>
      )}
    </div>
  );
}
