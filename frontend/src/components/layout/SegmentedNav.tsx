import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface SegmentedNavItem {
  label: string;
  href: string;
  /** Extra paths that should also light this segment (e.g. detail routes). */
  match?: string[];
}

/**
 * A small route-aware segmented control used to fold sibling pages under one
 * sidebar entry. Each segment is a <Link>; the one matching the current path is
 * highlighted. Used by Planner (Calendar | To-Do's) and the Dashboard
 * (Overview | Today) after those sidebar items were consolidated.
 */
export function SegmentedNav({
  items,
  className,
}: {
  items: SegmentedNavItem[];
  className?: string;
}) {
  const location = useLocation();

  const isActive = (it: SegmentedNavItem) => {
    const paths = [it.href, ...(it.match ?? [])];
    return paths.some((p) =>
      // For the root path, only an exact match counts (everything starts with '/').
      p === '/' ? location.pathname === '/' : location.pathname === p || location.pathname.startsWith(p + '/'),
    );
  };

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1',
        className,
      )}
    >
      {items.map((it) => {
        const active = isActive(it);
        return (
          <Link
            key={it.href}
            to={it.href}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
