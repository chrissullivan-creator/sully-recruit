import { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface QuickAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface MenuItem {
  /** A separator before this item. */
  separatorBefore?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

interface RowActionsProps {
  /** Icon buttons that fade in on row hover (hidden by default). */
  quickActions?: QuickAction[];
  /** Items behind the always-visible kebab. */
  menuItems?: MenuItem[];
  className?: string;
}

/**
 * Per-row action cluster. Quick actions are hidden until the parent row is
 * hovered (the row must carry the `group` class); the `MoreHorizontal` kebab is
 * always visible so touch users keep access. Quick actions `stopPropagation` so
 * clicking one never triggers the row's own navigation handler.
 */
export function RowActions({ quickActions = [], menuItems = [], className }: RowActionsProps) {
  const stop = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  return (
    <div className={cn('flex items-center justify-end gap-0.5', className)}>
      {quickActions.map((a, i) => (
        <Button
          key={i}
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-foreground"
          title={a.label}
          aria-label={a.label}
          disabled={a.disabled}
          onClick={stop(a.onClick)}
        >
          {a.icon}
        </Button>
      ))}

      {menuItems.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
            {menuItems.map((m, i) => (
              <div key={i}>
                {m.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={m.disabled}
                  onClick={stop(m.onClick)}
                  className={cn(m.destructive && 'text-destructive focus:text-destructive')}
                >
                  {m.icon && <span className="mr-2 flex h-4 w-4 items-center justify-center">{m.icon}</span>}
                  {m.label}
                </DropdownMenuItem>
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
