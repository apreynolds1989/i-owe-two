import { useEffect, type RefObject } from 'react';

/** While `open`, call `close` on any mouse-down outside `ref` (menus and popovers). */
export function useClickOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ref, open, close]);
}
