import { useState, useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { AskJoePanel } from './AskJoePanel';

/**
 * Global "Ask Joe" entry point — lives in the MainLayout top bar, so it's on
 * every page. A visible, inviting pill ("What do you want to know?") plus a
 * ⌘/Ctrl-J shortcut, opening the command-palette Ask Joe.
 */
export function AskJoeLauncher() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
      >
        <Sparkles className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium text-foreground">Ask Joe</span>
        <span className="hidden text-sm text-muted-foreground sm:inline">— What do you want to know?</span>
        <kbd className="ml-1 hidden items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground md:inline-flex">⌘J</kbd>
      </button>
      <AskJoePanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
