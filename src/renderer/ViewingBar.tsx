import { useState } from 'react';
import { LAST_DAYS, shiftDay, TRACKED, viewLabel, type ViewRange } from '../shared/range';
import type { AppState } from '../shared/types';
import { localToday, shortRange } from './dates';

const valueOf = (v: ViewRange) => (v.kind === 'lastDays' ? `last-${v.days}` : v.kind);

/**
 * "Viewing: My range ▾". Picking anything else is a temporary look at other dates: it's kept in memory
 * only, never saved to history, and never changes the tray. "Back to my range" returns.
 */
export function ViewingBar({ state }: { state: AppState }) {
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewing = state.viewing;
  const temporary = viewing.kind !== 'tracked';

  async function show(view: ViewRange) {
    setError(null);
    const result = await window.sprint.setViewing(view);
    if (result.ok) setCustom(null);
    else setError(result.error);
  }

  function pick(value: string) {
    if (value === 'custom') {
      const today = localToday();
      setCustom(viewing.kind === 'custom' ? { from: viewing.from, to: viewing.to } : { from: shiftDay(today, -13), to: today });
      return;
    }
    setCustom(null);
    const days = LAST_DAYS.find((d) => value === `last-${d}`);
    void show(days ? { kind: 'lastDays', days } : TRACKED);
  }

  return (
    <div className={`viewing${temporary ? ' temporary' : ''}`}>
      <div className="viewing-row">
        <label className="viewing-label">
          <span>Viewing</span>
          <select value={custom ? 'custom' : valueOf(viewing)} onChange={(e) => pick(e.target.value)}>
            <option value="tracked">My range</option>
            {LAST_DAYS.map((d) => (
              <option key={d} value={`last-${d}`}>
                {viewLabel({ kind: 'lastDays', days: d })}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
          </select>
        </label>
        {temporary && !custom && (
          <button className="link-button" onClick={() => void show(TRACKED)}>
            Back to my range
          </button>
        )}
      </div>
      {temporary && !custom && state.window && (
        <p className="viewing-note">
          {shortRange(state.window.from, state.window.to)} · just a look: not saved to history, and the tray still shows your range.
        </p>
      )}
      {custom && (
        <form
          className="viewing-custom"
          onSubmit={(e) => {
            e.preventDefault();
            void show({ kind: 'custom', ...custom });
          }}
        >
          <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          <button type="submit" className="button primary small-button">
            Show
          </button>
          <button type="button" className="button ghost small-button" onClick={() => (setCustom(null), setError(null))}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
