import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 1024;

/**
 * Returns true when the viewport is below the lg breakpoint (1024px).
 * Uses a matchMedia listener — no polling.
 */
export function useMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    // Sync on mount in case SSR value diverges
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
