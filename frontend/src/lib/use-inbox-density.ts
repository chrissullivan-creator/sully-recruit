import { useEffect, useState } from 'react';

export type InboxDensity = 'comfortable' | 'compact';

const STORAGE_KEY = 'inbox.density';
const DEFAULT_DENSITY: InboxDensity = 'comfortable';

function readStored(): InboxDensity {
  if (typeof window === 'undefined') return DEFAULT_DENSITY;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'compact' ? 'compact' : DEFAULT_DENSITY;
}

export function useInboxDensity(): [InboxDensity, (d: InboxDensity) => void] {
  const [density, setDensity] = useState<InboxDensity>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, density);
    } catch {
      // ignore quota / private-mode errors
    }
  }, [density]);

  return [density, setDensity];
}
