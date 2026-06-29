import { ReactNode, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface ActionMenuItem {
  key: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Render a divider above this item. */
  separatorBefore?: boolean;
}

interface ActionMenuProps {
  label: string;
  /** Icon shown before the label inside the trigger button. */
  leadingIcon?: ReactNode;
  items: ActionMenuItem[];
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  align?: 'start' | 'center' | 'end';
  className?: string;
  contentClassName?: string;
}

/**
 * A single primary button that reveals a menu of related actions on hover
 * (and click / tap). Used to collapse a cluster of toolbar buttons — e.g.
 * "Add Candidate ▾" → individual / bulk / CSV — into one uncluttered control.
 */
export function ActionMenu({
  label,
  leadingIcon,
  items,
  variant = 'gold',
  size,
  align = 'end',
  className,
  contentClassName,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openNow = () => {
    cancelClose();
    setOpen(true);
  };
  // Small grace period so dragging the cursor across the gap from the trigger
  // to the menu (or briefly off an edge) doesn't snap it shut.
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={cn('gap-1.5', className)}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
        >
          {leadingIcon}
          {label}
          <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className={cn('w-60', contentClassName)}
        onMouseEnter={cancelClose}
        onMouseLeave={closeSoon}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {items.map((item) => (
          <div key={item.key}>
            {item.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="cursor-pointer gap-2.5 py-2"
              onSelect={() => item.onSelect()}
            >
              {item.icon && (
                <span className="mt-0.5 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                  {item.icon}
                </span>
              )}
              <span className="flex flex-col">
                <span className="text-sm font-medium leading-tight text-foreground">{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
