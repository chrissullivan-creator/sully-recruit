import { useEffect } from 'react';

/**
 * Show the browser's native "leave site? changes you made may not be saved"
 * confirm prompt while `dirty` is true.
 *
 * Use it in any form / editor that has unpersisted state. Pass `dirty=true`
 * once the user starts typing, set it back to `false` after a successful
 * save, and the hook handles the rest.
 *
 * The browser ignores any custom message string — modern Chrome / Firefox
 * / Safari always render their own copy. Returning `true` from beforeunload
 * is the universal way to opt in.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Setting returnValue is required by older browsers.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
