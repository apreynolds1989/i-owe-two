import type { SprintWindow } from '../shared/args';
import { windowDays } from '../shared/range';
import { RATIO_SUPER, RATIO_TARGET, RATIO_WARN, reviewRatio, SUPER_REVIEWS_PER_WEEK, superMinReviews } from '../shared/ratio';
import type { SprintMetrics } from '../shared/types';

/** The gauge runs from 0 to GAUGE_MAX; anything above sits at the end. */
const GAUGE_MAX = 5;
const pct = (v: number) => `${(Math.min(v, GAUGE_MAX) / GAUGE_MAX) * 100}%`;

// Fixed spots (as % of the card) with staggered timing, so the twinkle looks scattered rather than in sync.
const SPARKLES = [
  { left: 6, top: 14, size: 11, delay: 0 },
  { left: 24, top: 78, size: 8, delay: 0.7 },
  { left: 50, top: 8, size: 9, delay: 1.3 },
  { left: 66, top: 70, size: 12, delay: 0.4 },
  { left: 84, top: 16, size: 10, delay: 1.0 },
  { left: 94, top: 60, size: 8, delay: 1.6 },
];

/**
 * The headline: PRs reviewed ÷ PRs authored, with a gauge against the 1.75 / 2.0 / 4.0 marks.
 * `window` is the range on screen: the reviews needed for super scale with its length.
 */
export function RatioCard({ metrics, window }: { metrics: SprintMetrics | null; window: SprintWindow | null }) {
  const minReviews = superMinReviews(window ? windowDays(window) : 7);
  const ratio = metrics ? reviewRatio(metrics.reviewed.count, metrics.authored.count, minReviews) : null;
  const status = ratio?.status ?? 'none';
  const isSuper = status === 'super';
  // The super zone reads as locked (striped, dimmed) until there are enough reviews to reach it.
  const superLocked = (metrics?.reviewed.count ?? 0) < minReviews;

  return (
    <section
      className={`ratio-card ratio-${status}`}
      title={`PRs reviewed ÷ PRs authored. Target ${RATIO_TARGET.toFixed(1)} or higher. Super-powered at ${RATIO_SUPER.toFixed(1)}+ with ${minReviews}+ reviews in this range (${SUPER_REVIEWS_PER_WEEK} a week).`}
    >
      {isSuper && (
        <span className="sparkles" aria-hidden="true">
          {SPARKLES.map((s, i) => (
            <span
              key={i}
              className="sparkle"
              style={{ left: `${s.left}%`, top: `${s.top}%`, fontSize: s.size, animationDelay: `${s.delay}s` }}
            >
              ✦
            </span>
          ))}
        </span>
      )}
      <div className="ratio-top">
        <span className="ratio-value">{ratio?.display ?? '–'}</span>
        <span className="ratio-text">
          <span className="ratio-label">{isSuper ? 'Review ratio ⚡ Super-powered' : 'Review ratio'}</span>
          <span className="ratio-status">{ratio ? ratio.label : 'Waiting for numbers…'}</span>
        </span>
      </div>

      <div className="gauge" aria-hidden="true">
        <div className="gauge-track">
          <span className="gauge-zone zone-bad" style={{ width: pct(RATIO_WARN) }} />
          <span className="gauge-zone zone-warn" style={{ left: pct(RATIO_WARN), width: `calc(${pct(RATIO_TARGET)} - ${pct(RATIO_WARN)})` }} />
          <span className="gauge-zone zone-good" style={{ left: pct(RATIO_TARGET), width: `calc(${pct(RATIO_SUPER)} - ${pct(RATIO_TARGET)})` }} />
          <span className={`gauge-zone zone-super${superLocked ? ' zone-locked' : ''}`} style={{ left: pct(RATIO_SUPER), right: 0 }} />
          {ratio?.value != null && <span className="gauge-marker" style={{ left: pct(ratio.value) }} />}
        </div>
        <div className="gauge-labels">
          <span style={{ left: pct(RATIO_TARGET) }}>{RATIO_TARGET.toFixed(1)}</span>
          {/* Locked, the label is too long to centre on the 4.0 tick, so it's right-aligned to the track end instead. */}
          <span className={superLocked ? 'label-locked' : undefined} style={superLocked ? { right: 0 } : { left: pct(RATIO_SUPER) }}>
            {RATIO_SUPER.toFixed(1)}
            {superLocked && ` · ${minReviews} reviews`}
          </span>
        </div>
      </div>
    </section>
  );
}
