// Where the panel goes, kept free of Electron imports so scripts/check.ts can test every taskbar edge.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 8; // space between the panel and the taskbar / screen edge

/**
 * Position the panel against the taskbar, next to the tray icon. The taskbar edge is found by
 * comparing the display's full bounds with its work area (the part the taskbar doesn't cover).
 */
export function panelPosition(
  tray: Rect,
  display: { bounds: Rect; workArea: Rect },
  size: { width: number; height: number },
  platform: string,
): { x: number; y: number } {
  const { bounds: b, workArea: w } = display;
  const cx = tray.x + tray.width / 2;
  const cy = tray.y + tray.height / 2;
  let x: number;
  let y: number;

  if (platform === 'darwin' || w.y > b.y) {
    // Menu bar (Mac) or a taskbar along the top: drop down below it, centred on the icon.
    x = cx - size.width / 2;
    y = w.y + GAP;
  } else if (w.x > b.x) {
    // Taskbar on the left.
    x = w.x + GAP;
    y = cy - size.height / 2;
  } else if (w.x + w.width < b.x + b.width) {
    // Taskbar on the right.
    x = w.x + w.width - size.width - GAP;
    y = cy - size.height / 2;
  } else {
    // Taskbar at the bottom (Windows' default), or auto-hidden.
    x = cx - size.width / 2;
    y = w.y + w.height - size.height - GAP;
  }

  // Keep the whole panel inside the work area.
  x = Math.min(Math.max(x, w.x + GAP), w.x + w.width - size.width - GAP);
  y = Math.min(Math.max(y, w.y + GAP), w.y + w.height - size.height - GAP);
  return { x: Math.round(x), y: Math.round(y) };
}

/** True if any part of `r` is on the work area (used to drop a saved position from an unplugged monitor). */
export const overlaps = (r: Rect, area: Rect) =>
  r.x < area.x + area.width && r.x + r.width > area.x && r.y < area.y + area.height && r.y + r.height > area.y;
