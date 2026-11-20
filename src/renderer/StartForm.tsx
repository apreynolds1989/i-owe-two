import { useState, type FormEvent } from 'react';
import { isValidDate } from '../shared/args';
import { periodContaining, RANGE_KINDS, RANGE_LABELS, shiftDay, validRange, type RangeKind } from '../shared/range';
import type { AppState, HistoryChoice, StartInput } from '../shared/types';
import { isValidLogin, parseLabels } from '../shared/validate';
import { localToday, shortRange } from './dates';

type Form = Omit<StartInput, 'historyChoice'>;

/** Defaults: the last values used, or the token owner and a week starting today. */
function defaults(state: AppState): Form {
  if (state.settings) {
    const s = state.settings;
    return { owner: s.owner, login: s.login, kind: s.range.kind, start: s.range.start, ignoreLabels: s.ignoreLabels.join(', ') };
  }
  const me = state.viewerLogin ?? '';
  return { owner: me, login: me, kind: 'week', start: localToday(), ignoreLabels: '' };
}

/** "Current: Nov 17 – 23 · next starts Nov 24" for a valid range, else null. */
function preview(form: Form): string | null {
  const range = validRange({ kind: form.kind, start: form.start });
  if (!range) return null;
  const now = periodContaining(range, localToday());
  if (range.kind === 'day') return 'Today only, starting again each day at midnight.';
  return `Current: ${shortRange(now.from, now.to)} · next starts ${shortRange(shiftDay(now.to, 1), shiftDay(now.to, 1))}.`;
}

export function StartForm({ state }: { state: AppState }) {
  const [form, setForm] = useState(() => defaults(state));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when saving would retire existing history: the person picks archive, delete or cancel. */
  const [choice, setChoice] = useState<HistoryChoice | null>(null);
  const set = (key: keyof Form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setChoice(null);
  };

  async function send(historyChoice?: 'archive' | 'delete') {
    setBusy(true);
    setError(null);
    try {
      const result = await window.sprint.start({ ...form, historyChoice });
      if (result.ok) return;
      if ('historyChoice' in result) setChoice(result.historyChoice);
      else setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // Checked here for quick feedback; the main process checks everything again.
    if (!isValidLogin(form.owner.trim())) return setError('"Where" must be a GitHub username or organization name.');
    if (!isValidLogin(form.login.trim())) return setError('Enter a valid GitHub username.');
    if (!isValidDate(form.start) || !validRange({ kind: form.kind, start: form.start })) return setError('Choose a valid start date.');
    const labels = parseLabels(form.ignoreLabels);
    if (!Array.isArray(labels)) return setError(labels.error);
    void send();
  }

  const hint = preview(form);

  return (
    <div className="screen">
      <div className="screen-title">
        <div>
          <h2>Choose your range</h2>
          <p className="muted">Whose pull requests, and how often your range starts over.</p>
        </div>
      </div>

      <form className="card form" onSubmit={submit}>
        <label className="field">
          <span>Where</span>
          <input value={form.owner} onChange={set('owner')} placeholder="organization or username" spellCheck={false} />
          <small className="muted">The organization (or your username) your token was created for.</small>
        </label>
        <label className="field">
          <span>GitHub user</span>
          <input value={form.login} onChange={set('login')} placeholder="username" spellCheck={false} />
          <small className="muted">Whose PRs to count. Defaults to you.</small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Range</span>
            <select value={form.kind} onChange={set('kind')}>
              {RANGE_KINDS.map((k: RangeKind) => (
                <option key={k} value={k}>
                  {RANGE_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Starts on</span>
            <input type="date" value={form.start} onChange={set('start')} />
          </label>
        </div>
        <small className="muted range-preview">
          {hint ?? 'Pick the day a range begins, e.g. your sprint’s first day.'} Your history is kept for this range.
        </small>
        <label className="field">
          <span>
            Ignore PRs labelled <span className="muted">(optional)</span>
          </span>
          <input value={form.ignoreLabels} onChange={set('ignoreLabels')} placeholder="e.g. do not review, wip" spellCheck={false} />
          <small className="muted">Comma-separated. These are left out of "Need reviewers".</small>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {choice ? (
          <div className="history-choice" role="alertdialog" aria-label="Existing history">
            <p>
              You have {choice.periods} {choice.periods === 1 ? 'period' : 'periods'} of {RANGE_LABELS[choice.kind].toLowerCase()} history
              starting {shortRange(choice.start, choice.start)}. These settings start a new history.
            </p>
            <div className="form-actions">
              <button type="button" className="button ghost" onClick={() => setChoice(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="button ghost danger" onClick={() => void send('delete')} disabled={busy}>
                Delete & start new
              </button>
              <button type="button" className="button primary" onClick={() => void send('archive')} disabled={busy}>
                Archive & start new
              </button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            {state.settings && (
              <button type="button" className="button ghost" onClick={() => window.sprint.showView('metrics')}>
                Cancel
              </button>
            )}
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? 'Checking…' : 'Start'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
