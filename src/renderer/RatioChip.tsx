import type { ReviewRatio } from '../shared/ratio';

/** A small pill with a ratio's value, coloured by its status. `title` is the hover text, if any. */
export function RatioChip({ ratio, title }: { ratio: ReviewRatio; title?: string }) {
  return (
    <span className={`ratio-chip chip-${ratio.status}`} title={title}>
      {ratio.display}
    </span>
  );
}
