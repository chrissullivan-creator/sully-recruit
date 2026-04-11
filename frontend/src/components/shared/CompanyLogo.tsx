import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

export type CompanyLogoSize = 'xs' | 'sm' | 'md' | 'lg';

interface Props {
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
 * Renders a company logo from Clearbit's free logo CDN, with a graceful
 * initials-avatar fallback when no domain is provided or when the image
 * fails to load. Pure client-side, no caching layer needed — the browser's
 * HTTP cache handles repeated requests.
 */
export function CompanyLogo({ domain, name, size = 'sm', className, rounded = 'md' }: Props) {
  const px = SIZE_PX[size];
  const cleanDomain = domain ? normalizeDomain(domain) : '';
  const [failed, setFailed] = useState(false);

  // Reset error state when the domain changes so a new domain gets a fresh attempt
  useEffect(() => {
    setFailed(false);
  }, [cleanDomain]);

  const showImage = !!cleanDomain && !failed;
  const initial = (name?.trim()?.[0] || '?').toUpperCase();
  const radiusClass = rounded === 'full' ? 'rounded-full' : 'rounded-md';

  if (showImage) {
    return (
      <img
        src={`https://logo.clearbit.com/${cleanDomain}`}
        alt={name}
        loading="lazy"
        onError={() => setFailed(true)}
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
