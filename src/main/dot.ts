// Paints the tray icon's status dot into raw pixels. Kept free of Electron so scripts/check.ts can test it.
// Bitmaps are Electron's native format: 4 bytes per pixel, B G R A, with premultiplied alpha.
import type { RatioStatus } from '../shared/ratio';

export type Rgb = readonly [number, number, number];

/** Bright enough to read at a few pixels on light and dark taskbars; the white ring separates it from the icon. */
export const DOT_COLORS: Record<Exclude<RatioStatus, 'none'>, Rgb> = {
  good: [34, 197, 94],
  warn: [245, 158, 11],
  bad: [239, 68, 68],
  super: [168, 85, 247],
};
const RING: Rgb = [255, 255, 255];

/**
 * A copy of `bitmap` (size × size) with a dot in the bottom-right corner: a coloured disc inside a white
 * ring, anti-aliased by how much of each pixel the circle covers. The input is left untouched.
 */
export function paintDot(bitmap: Uint8Array, size: number, color: Rgb): Uint8Array {
  const out = Uint8Array.from(bitmap);
  const outer = size * 0.25; // ring's outer radius
  const inner = outer - Math.max(1, size * 0.07); // coloured disc's radius
  const c = size - outer - 0.5; // centre, inset so the ring isn't clipped
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - (c + 0.5), y + 0.5 - (c + 0.5));
      const ringCover = Math.min(1, Math.max(0, outer + 0.5 - d));
      if (ringCover === 0) continue;
      const discCover = Math.min(1, Math.max(0, inner + 0.5 - d));
      // Blend ring and disc into one colour, then lay it over the icon ("over" with premultiplied alpha).
      const rgb = [0, 1, 2].map((i) => color[i]! * discCover + RING[i]! * (1 - discCover));
      const a = ringCover;
      const i = (y * size + x) * 4;
      out[i] = Math.round(rgb[2]! * a + out[i]! * (1 - a)); // B
      out[i + 1] = Math.round(rgb[1]! * a + out[i + 1]! * (1 - a)); // G
      out[i + 2] = Math.round(rgb[0]! * a + out[i + 2]! * (1 - a)); // R
      out[i + 3] = Math.round(255 * a + out[i + 3]! * (1 - a)); // A
    }
  }
  return out;
}
