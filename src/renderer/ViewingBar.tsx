// The "Viewing" picker under the context chip: the tracked range, a recent span, or custom dates.
import { useState } from 'react';
import { LAST_DAYS, shiftDay, TRACKED, viewLabel, type ViewRange } from '../shared/range';
import type { AppState } from '../shared/types';
import { localToday, shortRange } from './dates';

/** The <select> option value for a view ("tracked", "last-7", "custom"). */
const selectValueFor = (view: ViewRange) => (view.kind === 'lastDays' ? `last-${view.days}` : view.kind);
/** Custom dates start out as the last two weeks. */
const DEFAULT_CUSTOM_DAYS = 14;

/**
 * "Viewing: My range ▾". Picking anything else is a temporary look at other dates: it's kept in memory
 * only, never saved to history, and never changes the tray. "Back to my range" returns.
 */
export function ViewingBar({ state }: { state: AppState }) {
  /** The custom dates being edited (the form is open while this is set). */
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewing = state.viewing;
  const temporary = viewing.kind !== 'tracked';

  async function showRange(view: ViewRange) {
    setError(null);
    const result = await window.sprint.setViewing(view);
    if (result.ok) setCustom(null);
    else setError(result.error);
  }

  function selectRange(value: string) {
    if (value === 'custom') {
      const today = localToday();
      setCustom(
        viewing.kind === 'custom' ? { from: viewing.from, to: viewing.to } : { from: shiftDay(today, -(DEFAULT_CUSTOM_DAYS - 1)), to: today },
      );
      return;
    }
    setCustom(null);
    const days = LAST_DAYS.find((offered) => value === `last-${offered}`);
    void showRange(days ? { kind: 'lastDays', days } : TRACKED);
  }

  return (
    <div className={`viewing${temporary ? ' temporary' : ''}`}>
      <div className="viewing-row">
        <label className="viewing-label">
          <span>Viewing</span>
          <select value={custom ? 'custom' : selectValueFor(viewing)} onChange={(event) => selectRange(event.target.value)}>
            <option value="tracked">My range</option>
            {LAST_DAYS.map((days) => (
              <option key={days} value={`last-${days}`}>
                {viewLabel({ kind: 'lastDays', days })}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
          </select>
        </label>
        {temporary && !custom && (
          <button className="link-button" onClick={() => void showRange(TRACKED)}>
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
          onSubmit={(event) => {
            event.preventDefault();
            void showRange({ kind: 'custom', ...custom });
          }}
        >
          <input type="date" aria-label="From" value={custom.from} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={custom.to} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
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
