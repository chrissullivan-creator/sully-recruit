import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

export type CompanyLogoSize = 'xs' | 'sm' | 'md' | 'lg';

interface Props {
  /** Direct logo URL — preferred when present (e.g. populated by
   *  Apollo enrichment into `companies.logo_url`). */
  logoUrl?: string | null;
  domain?: string | null;
  name: string;
  size?: CompanyLogoSize;
  className?: string;
  rounded?: 'md' | 'full';
}

const SIZE_PX: Record<CompanyLogoSize, number> = {
  xs: 20,
  sm: 28,
  md: 36,
  lg: 56,
};

const TEXT_CLASS: Record<CompanyLogoSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
};

function normalizeDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

/**
 * Renders a company logo with a three-tier fallback:
 *   1. `logoUrl` if provided (e.g. populated by Apollo enrichment)
 *   2. Clearbit CDN keyed on `domain`
 *   3. Initials avatar
 * Each tier falls through to the next on image-load error. Pure
 * client-side; browser HTTP cache handles repeated requests.
 */
export function CompanyLogo({ logoUrl, domain, name, size = 'sm', className, rounded = 'md' }: Props) {
  const px = SIZE_PX[size];
  const cleanDomain = domain ? normalizeDomain(domain) : '';
  const [stage, setStage] = useState<'direct' | 'clearbit' | 'initials'>(
    logoUrl ? 'direct' : cleanDomain ? 'clearbit' : 'initials',
  );

  // Reset stage when sources change so a new logoUrl/domain gets a fresh attempt
  useEffect(() => {
    if (logoUrl) setStage('direct');
    else if (cleanDomain) setStage('clearbit');
    else setStage('initials');
  }, [logoUrl, cleanDomain]);

  const initial = (name?.trim()?.[0] || '?').toUpperCase();
  const radiusClass = rounded === 'full' ? 'rounded-full' : 'rounded-md';

  if (stage === 'direct' && logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={name}
        loading="lazy"
        onError={() => setStage(cleanDomain ? 'clearbit' : 'initials')}
        style={{ width: px, height: px }}
        className={cn(radiusClass, 'object-contain bg-white border border-border shrink-0', className)}
      />
    );
  }

  if (stage === 'clearbit' && cleanDomain) {
    return (
      <img
        src={`https://logo.clearbit.com/${cleanDomain}`}
        alt={name}
        loading="lazy"
        onError={() => setStage('initials')}
        style={{ width: px, height: px }}
        className={cn(radiusClass, 'object-contain bg-white border border-border shrink-0', className)}
      />
    );
  }

  return (
    <div
      style={{ width: px, height: px }}
      className={cn(
        radiusClass,
        'flex items-center justify-center bg-accent/10 text-accent font-medium shrink-0',
        TEXT_CLASS[size],
        className,
      )}
      aria-label={name}
      title={name}
    >
      {initial}
    </div>
  );
}
