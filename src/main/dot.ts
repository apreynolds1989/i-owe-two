// Paints the tray icon's status dot into raw pixels. Kept free of Electron so scripts/check.ts can test it.
// Bitmaps are Electron's native format: 4 bytes per pixel, B G R A, with premultiplied alpha.
import type { RatioStatus } from '../shared/ratio';

type Rgb = readonly [number, number, number];

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
  const outerRadius = size * 0.25; // the white ring's outer edge
  const innerRadius = outerRadius - Math.max(1, size * 0.07); // the coloured disc's edge
  const center = size - outerRadius - 0.5; // inset so the ring isn't clipped
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Measured from pixel centres, hence the + 0.5s.
      const distance = Math.hypot(x + 0.5 - (center + 0.5), y + 0.5 - (center + 0.5));
      // How much of this pixel each circle covers (0..1): a one-pixel ramp at the edge gives the anti-aliasing.
      const ringCover = Math.min(1, Math.max(0, outerRadius + 0.5 - distance));
      if (ringCover === 0) continue;
      const discCover = Math.min(1, Math.max(0, innerRadius + 0.5 - distance));
      // Blend ring and disc into one colour, then lay it over the icon ("over" with premultiplied alpha).
      const blended = [0, 1, 2].map((channel) => color[channel]! * discCover + RING[channel]! * (1 - discCover));
      const alpha = ringCover;
      const pixelIndex = (y * size + x) * 4;
      out[pixelIndex] = Math.round(blended[2]! * alpha + out[pixelIndex]! * (1 - alpha)); // B
      out[pixelIndex + 1] = Math.round(blended[1]! * alpha + out[pixelIndex + 1]! * (1 - alpha)); // G
      out[pixelIndex + 2] = Math.round(blended[0]! * alpha + out[pixelIndex + 2]! * (1 - alpha)); // R
      out[pixelIndex + 3] = Math.round(255 * alpha + out[pixelIndex + 3]! * (1 - alpha)); // A
    }
  }
  return out;
}
