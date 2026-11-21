// The Start screen: where to look, whose PRs to count, the tracked range, and labels to ignore.
import { useState, type FormEvent } from 'react';
import { isValidDate } from '../shared/dateWindow';
import { periodContaining, RANGE_KINDS, RANGE_LABELS, shiftDay, validRange, type RangeKind } from '../shared/range';
import type { AppState, HistoryChoice, StartInput } from '../shared/types';
import { isValidLogin, parseLabels } from '../shared/validate';
import { localToday, shortRange } from './dates';

type Form = Omit<StartInput, 'historyChoice'>;

/** Defaults: the last values used, or the token owner and a week starting today. */
function defaults(state: AppState): Form {
  if (state.settings) {
    const { owner, login, range, ignoreLabels } = state.settings;
    return { owner, login, kind: range.kind, start: range.start, ignoreLabels: ignoreLabels.join(', ') };
  }
  const me = state.viewerLogin ?? '';
  return { owner: me, login: me, kind: 'week', start: localToday(), ignoreLabels: '' };
}

/** "Current: Nov 17 – 23 · next starts Nov 24" for a valid range, else null. */
function rangePreview(form: Form): string | null {
  const range = validRange({ kind: form.kind, start: form.start });
  if (!range) return null;
  const current = periodContaining(range, localToday());
  if (range.kind === 'day') return 'Today only, starting again each day at midnight.';
  const nextStart = shiftDay(current.to, 1);
  return `Current: ${shortRange(current.from, current.to)} · next starts ${shortRange(nextStart, nextStart)}.`;
}

/** The Start screen. Checks the form for quick feedback; the main process checks everything again on save. */
export function StartForm({ state }: { state: AppState }) {
  const [form, setForm] = useState(() => defaults(state));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set when saving would retire existing history: the person picks archive, delete or cancel. */
  const [choice, setChoice] = useState<HistoryChoice | null>(null);
  /** An onChange handler for one field. Any edit drops a pending history question (it was for the old values). */
  const updateField = (key: keyof Form) => (event: { target: { value: string } }) => {
    setForm({ ...form, [key]: event.target.value });
    setChoice(null);
  };

  async function submitSettings(historyChoice?: 'archive' | 'delete') {
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
    void submitSettings();
  }

  const hint = rangePreview(form);

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
          <input value={form.owner} onChange={updateField('owner')} placeholder="organization or username" spellCheck={false} />
          <small className="muted">The organization (or your username) your token was created for.</small>
        </label>
        <label className="field">
          <span>GitHub user</span>
          <input value={form.login} onChange={updateField('login')} placeholder="username" spellCheck={false} />
          <small className="muted">Whose PRs to count. Defaults to you.</small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Range</span>
            <select value={form.kind} onChange={updateField('kind')}>
              {RANGE_KINDS.map((kind: RangeKind) => (
                <option key={kind} value={kind}>
                  {RANGE_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Starts on</span>
            <input type="date" value={form.start} onChange={updateField('start')} />
          </label>
        </div>
        <small className="muted range-preview">
          {hint ?? 'Pick the day a range begins, e.g. your sprint’s first day.'} Your history is kept for this range.
        </small>
        <label className="field">
          <span>
            Ignore PRs labelled <span className="muted">(optional)</span>
          </span>
          <input value={form.ignoreLabels} onChange={updateField('ignoreLabels')} placeholder="e.g. do not review, wip" spellCheck={false} />
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
              <button type="button" className="button ghost danger" onClick={() => void submitSettings('delete')} disabled={busy}>
                Delete & start new
              </button>
              <button type="button" className="button primary" onClick={() => void submitSettings('archive')} disabled={busy}>
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
