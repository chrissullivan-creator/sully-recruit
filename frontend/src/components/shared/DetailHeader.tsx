import { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DetailHeaderProps {
  /** Avatar / logo node (PersonAvatar, CompanyLogo, …). */
  avatar?: ReactNode;
  title: ReactNode;
  /** Line under the title — role / company / location. */
  subtitle?: ReactNode;
  /** Status / tag badges rendered after the title. */
  badges?: ReactNode;
  /** Small circular contact-action icons (email, call, LinkedIn). */
  contactActions?: ReactNode;
  /** Right-aligned primary actions (buttons, more-menu). */
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  className?: string;
}

/**
 * Shared detail-page header — the avatar + name + badges + contact-icons +
 * actions block used by Candidate / Contact / Job / Company detail pages.
 * Standardizes spacing and the back link so every detail page reads the same.
 */
export function DetailHeader({
  avatar, title, subtitle, badges, contactActions, actions, onBack, backLabel = 'Back', className,
}: DetailHeaderProps) {
  return (
    <div className={cn('border-b border-card-border bg-card/60', className)}>
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-6 pt-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </button>
      )}
      <div className="flex flex-col gap-4 px-6 py-5 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4 min-w-0">
          {avatar && <div className="shrink-0">{avatar}</div>}
          {/* Identity stack — name → role/company/location → tag row, mirroring
              the design mockup (tags sit on their own line, not beside the name). */}
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">{title}</h1>
            {subtitle && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {subtitle}
              </div>
            )}
            {badges && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {badges}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {contactActions}
          {contactActions && actions && <span className="mx-1 h-6 w-px bg-card-border" />}
          {actions}
        </div>
      </div>
    </div>
  );
}
