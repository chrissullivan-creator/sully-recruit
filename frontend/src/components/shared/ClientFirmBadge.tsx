import { BadgeCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Marker shown when a person works at a *client firm* — a company whose
 * company_status is 'client'. Signals that Emerald is an approved vendor
 * there (the same fact the optional sequence "approved vendor" line uses).
 */
export function ClientFirmBadge({
  companyStatus,
  className,
}: {
  companyStatus?: string | null;
  className?: string;
}) {
  if (companyStatus !== 'client') return null;
  return (
    <span
      title="Works at a client firm — we're an approved vendor"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent shrink-0',
        className,
      )}
    >
      <BadgeCheck className="h-3 w-3" /> Approved Vendor
    </span>
  );
}
