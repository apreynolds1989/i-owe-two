// The tray icon and the panel that opens from it, in the style of JetBrains Toolbox: click the icon and
// a rounded panel appears next to it; click away (or press Esc) and it hides. Pinning keeps it open,
// always on top and draggable.
import { app, BrowserWindow, nativeImage, screen, Tray, type NativeImage } from 'electron';
import { join } from 'node:path';
import type { RatioStatus } from '../shared/ratio';
import { DOT_COLORS, paintDot } from './dot';
import { overlaps, panelPosition, type Rect } from './placement';
import { hardenWebContents, INDEX_URL } from './security';

const PANEL_SIZE = { width: 380, height: 600 };

/** The app icon (assets/icon.png), used for the tray and the window. */
export function loadIcon(appDir: string): NativeImage {
  return nativeImage.createFromPath(join(appDir, 'assets', 'icon.png'));
}

/** The tray icon, plain until there are numbers to show. */
export function createTray(icon: NativeImage): Tray {
  return new Tray(trayImage(icon, 'none'));
}

/**
 * The tray icon at 16 px (1x) and 32 px (2x), with a dot in the corner showing the ratio's status.
 * 'none' (no numbers yet, or nothing authored) is the plain icon.
 */
export function trayImage(icon: NativeImage, status: RatioStatus): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor;
    const base = icon.resize({ width: size, height: size, quality: 'best' });
    const pixels = status === 'none' ? base.toBitmap() : Buffer.from(paintDot(base.toBitmap(), size, DOT_COLORS[status]));
    const png = nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG();
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: png });
  }
  return image;
}

/** The hidden, frameless, sandboxed panel window, loading the UI from app://. Shown by main.ts. */
export function createPanel(preload: string, icon: NativeImage): BrowserWindow {
  const panel = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    transparent: true, // rounded corners and the shadow are drawn by the page
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: 'IO2',
    icon,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  hardenWebContents(panel.webContents);
  void panel.loadURL(INDEX_URL);
  return panel;
}

/** Position next to the tray icon. If Windows reports no bounds (icon in the ^ overflow), use the click point. */
export function placeNearTray(panel: BrowserWindow, tray: Tray): void {
  let anchor = tray.getBounds();
  if (anchor.width === 0 || anchor.height === 0) {
    const cursor = screen.getCursorScreenPoint();
    anchor = { x: cursor.x, y: cursor.y, width: 1, height: 1 };
  }
  const display = screen.getDisplayNearestPoint({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 });
  const { x, y } = panelPosition(anchor, display, PANEL_SIZE, process.platform);
  panel.setBounds({ x, y, ...PANEL_SIZE });
}

/** Saved pinned position, if it's still on a connected display (a monitor may have been unplugged). */
export function visibleBounds(saved: Rect | null): Rect | null {
  if (!saved) return null;
  const bounds = { ...saved, ...PANEL_SIZE };
  return overlaps(bounds, screen.getDisplayMatching(bounds).workArea) ? bounds : null;
}
