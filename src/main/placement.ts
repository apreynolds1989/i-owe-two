// Where the panel goes, kept free of Electron imports so scripts/check.ts can test every taskbar edge.

/** A rectangle in screen coordinates (also the panel's saved bounds). */
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
  const { bounds: screenBounds, workArea } = display;
  const trayCenterX = tray.x + tray.width / 2;
  const trayCenterY = tray.y + tray.height / 2;
  let x: number;
  let y: number;

  if (platform === 'darwin' || workArea.y > screenBounds.y) {
    // Menu bar (Mac) or a taskbar along the top: drop down below it, centred on the icon.
    x = trayCenterX - size.width / 2;
    y = workArea.y + GAP;
  } else if (workArea.x > screenBounds.x) {
    // Taskbar on the left.
    x = workArea.x + GAP;
    y = trayCenterY - size.height / 2;
  } else if (workArea.x + workArea.width < screenBounds.x + screenBounds.width) {
    // Taskbar on the right.
    x = workArea.x + workArea.width - size.width - GAP;
    y = trayCenterY - size.height / 2;
  } else {
    // Taskbar at the bottom (Windows' default), or auto-hidden.
    x = trayCenterX - size.width / 2;
    y = workArea.y + workArea.height - size.height - GAP;
  }

  // Keep the whole panel inside the work area.
  x = Math.min(Math.max(x, workArea.x + GAP), workArea.x + workArea.width - size.width - GAP);
  y = Math.min(Math.max(y, workArea.y + GAP), workArea.y + workArea.height - size.height - GAP);
  return { x: Math.round(x), y: Math.round(y) };
}

/** True if any part of `r` is on the work area (used to drop a saved position from an unplugged monitor). */
export const overlaps = (rect: Rect, area: Rect) =>
  rect.x < area.x + area.width && rect.x + rect.width > area.x && rect.y < area.y + area.height && rect.y + rect.height > area.y;
