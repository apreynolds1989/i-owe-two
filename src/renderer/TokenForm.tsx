import { useState, type FormEvent } from 'react';
import type { AppState } from '../shared/types';
import { checkToken } from '../shared/validate';
import { ExternalIcon, KeyIcon } from './icons';

const TOKENS_PAGE = 'https://github.com/settings/personal-access-tokens';

export function TokenForm({ state }: { state: AppState }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = checkToken(value);
    if ('error' in checked) return setError(checked.error);
    setBusy(true);
    setError(null);
    try {
      const result = await window.sprint.saveToken(checked.token);
      if (!result.ok) setError(result.error);
    } catch {
      setError('Something went wrong saving the token. Please try again.');
    } finally {
      // Clear the field either way: the token lives (encrypted) in the main process only.
      setValue('');
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="screen-title">
        <span className="screen-icon">
          <KeyIcon />
        </span>
        <div>
          <h2>Connect to GitHub</h2>
          <p className="muted">Paste a read-only token. It stays on this computer.</p>
        </div>
      </div>

      <form className="card form" onSubmit={submit}>
        <label className="field">
          <span>Fine-grained token</span>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          {state.hasToken && (
            <button type="button" className="button ghost" onClick={() => window.sprint.showView(state.settings ? 'metrics' : 'start')}>
              Cancel
            </button>
          )}
          <button type="submit" className="button primary" disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Save token'}
          </button>
        </div>
        {!state.tokenPersisted && (
          <p className="muted small">
            This computer can't encrypt saved secrets, so the token is only kept until you quit the app.
          </p>
        )}
      </form>

      <section className="card guide">
        <h3>How to get a token</h3>
        <ol>
          <li>
            On GitHub, open{' '}
            <a href={TOKENS_PAGE} target="_blank" rel="noreferrer">
              Settings › Developer settings › Fine-grained tokens <ExternalIcon />
            </a>{' '}
            and choose <b>Generate new token</b>.
          </li>
          <li>
            Name it <b>ReciPRocity</b> and pick an expiry (90 days is a good default).
          </li>
          <li>
            Set <b>Resource owner</b> to the organization (or your own account) whose pull requests you want to see, and{' '}
            <b>Repository access</b> to <b>All repositories</b>.
          </li>
          <li>
            Under <b>Permissions</b>, set <b>Pull requests</b> to <b>Read-only</b>. <b>Metadata</b> is added as read-only
            automatically. Leave everything else as <b>No access</b>.
          </li>
          <li>
            Generate the token, copy it, and paste it above.
          </li>
        </ol>
        <p className="muted small">
          If your organization requires approval for tokens, an admin will need to approve it before it works. You can revoke
          the token on the same GitHub page at any time.
        </p>
        <p className="muted small">
          Tip: copied text can stay in your clipboard history (Windows: <b>Win + V</b>). Once the token is saved, you can
          delete it from there.
        </p>
      </section>

      {state.hasToken && (
        <button type="button" className="link-button danger" onClick={() => void window.sprint.clearToken()}>
          Remove the saved token from this computer
        </button>
      )}
    </div>
  );
}
