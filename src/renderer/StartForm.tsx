import { useState, type FormEvent } from 'react';
import { parseWindow } from '../shared/args';
import type { AppState } from '../shared/types';
import { isValidLogin, parseLabels } from '../shared/validate';

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Defaults: the last values used, or the token owner and the last 14 days. */
function defaults(state: AppState) {
  if (state.settings) {
    const s = state.settings;
    return { owner: s.owner, login: s.login, from: s.from, to: s.to, ignoreLabels: s.ignoreLabels.join(', ') };
  }
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 13);
  const me = state.viewerLogin ?? '';
  return { owner: me, login: me, from: ymd(start), to: ymd(today), ignoreLabels: '' };
}

export function StartForm({ state }: { state: AppState }) {
  const [form, setForm] = useState(() => defaults(state));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Checked here for quick feedback; the main process checks everything again.
    if (!isValidLogin(form.owner.trim())) return setError('"Where" must be a GitHub username or organization name.');
    if (!isValidLogin(form.login.trim())) return setError('Enter a valid GitHub username.');
    const w = parseWindow(form.from, form.to);
    if ('error' in w) return setError(w.error);
    const labels = parseLabels(form.ignoreLabels);
    if (!Array.isArray(labels)) return setError(labels.error);
    setBusy(true);
    setError(null);
    try {
      const result = await window.sprint.start(form);
      if (!result.ok) setError(result.error);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="screen-title">
        <div>
          <h2>Choose a sprint</h2>
          <p className="muted">Whose pull requests, and which dates.</p>
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
            <span>From</span>
            <input type="date" value={form.from} onChange={set('from')} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={form.to} onChange={set('to')} />
          </label>
        </div>
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
      </form>
    </div>
  );
}
