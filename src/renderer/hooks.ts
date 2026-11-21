// Small React hooks shared by several components.
import { useCallback, useEffect, useEffectEvent, useState, type RefObject } from 'react';

/** While `open`, call `close` on any mouse-down outside `ref` (menus and popovers). */
export function useClickOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  // Callers pass a new inline `close` on every render. As an effect event it always calls the latest one
  // without being a dependency, so the listener is only added when the menu opens and removed when it closes.
  const onMouseDown = useEffectEvent((event: MouseEvent) => {
    if (!ref.current?.contains(event.target as Node)) close();
  });
  useEffect(() => {
    if (!open) return;
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);
}

/**
 * A set of keys that can each be switched in and out, e.g. which groups of a list are collapsed.
 * Kept in component state only (not remembered).
 */
export function useToggleSet(): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string) =>
      setKeys((previous) => {
        const next = new Set(previous);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  return [keys, toggle];
}
