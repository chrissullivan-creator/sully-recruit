import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

/**
 * Shared collapse state for the sidebar + main content padding.
 *
 * The sidebar can collapse to a slim icon rail; when it does, the main content
 * area's left padding has to follow. Lifting the boolean here (instead of into
 * Sidebar) lets MainLayout drive `--sidebar-w` off the same source of truth.
 * Persisted to localStorage and toggled with ⌘/Ctrl-B (mirrors the Ask-Joe ⌘J).
 */
interface SidebarCtx {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<SidebarCtx | null>(null);
const STORAGE_KEY = 'sidebar:collapsed';

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const toggle = () => setCollapsed(!collapsed);

  // ⌘/Ctrl-B toggles the rail from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed]);

  return (
    <Ctx.Provider value={{ collapsed, setCollapsed, toggle }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSidebar(): SidebarCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider');
  return ctx;
}
