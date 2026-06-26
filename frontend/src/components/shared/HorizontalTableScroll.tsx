import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  /**
   * Minimum width of the scrolled content. Tables narrower than this
   * will scroll horizontally on smaller viewports. Default 1100.
   */
  minWidth?: number;
  className?: string;
  /**
   * When true, the table scrolls vertically WITHIN a bounded-height box
   * (instead of the page), which is what lets a `position: sticky` table
   * header pin to the top while rows scroll under it. The consuming table's
   * <thead> must add `sticky top-0 z-20`. Default false (page scroll +
   * sticky bottom scrollbar, the original behavior).
   */
  stickyHeader?: boolean;
  /** Max height of the bounded scroll box in stickyHeader mode. Default '75vh'. */
  maxHeight?: string;
}

/**
 * Wrap a wide data table to make it horizontally scrollable AND keep a
 * sticky scrollbar pinned to the bottom of the viewport while the table
 * is on screen.
 *
 * Pattern: two stacked divs share the same scrollLeft.
 *   - top div is the actual scroll container holding the table
 *   - bottom div has `position: sticky; bottom: 0` and an inner spacer
 *     wide enough to inherit the same horizontal scroll. We keep their
 *     scrollLeft in sync both ways so dragging either scrolls both.
 *
 * The bottom bar lives outside the page sticky header by default
 * (z-index 30 < the global top bar's z-40).
 */
export function HorizontalTableScroll({ children, minWidth = 1100, className, stickyHeader = false, maxHeight = '75vh' }: Props) {
  const topRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stickyHeader) return; // bottom-mirror scrollbar isn't used in sticky mode
    const top = topRef.current;
    const bot = botRef.current;
    if (!top || !bot) return;

    let lock = false;
    const sync = (src: HTMLDivElement, dst: HTMLDivElement) => () => {
      if (lock) return;
      lock = true;
      dst.scrollLeft = src.scrollLeft;
      lock = false;
    };

    const a = sync(top, bot);
    const b = sync(bot, top);
    top.addEventListener('scroll', a, { passive: true });
    bot.addEventListener('scroll', b, { passive: true });
    return () => {
      top.removeEventListener('scroll', a);
      bot.removeEventListener('scroll', b);
    };
  }, []);

  // Sticky-header mode: a single bounded-height scroll box (both axes). The
  // table's sticky <thead> pins to the top of THIS box as rows scroll under it.
  if (stickyHeader) {
    return (
      <div className={cn('relative overflow-auto rounded-lg border border-border', className)} style={{ maxHeight }}>
        <div style={{ minWidth }}>{children}</div>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <div ref={topRef} className="overflow-x-auto">
        <div style={{ minWidth }}>{children}</div>
      </div>
      {/* Sticky scrollbar at viewport bottom. Pure scroll-mirror — height
          stays minimal so it doesn't eat real estate. */}
      <div
        ref={botRef}
        aria-hidden
        className="sticky bottom-0 z-30 overflow-x-auto bg-page-bg/90 backdrop-blur-sm border-t border-card-border"
        style={{ height: 14 }}
      >
        <div style={{ width: minWidth, height: 1 }} />
      </div>
    </div>
  );
}
