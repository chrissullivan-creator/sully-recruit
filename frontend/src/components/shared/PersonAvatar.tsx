import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

export type PersonAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_PX: Record<PersonAvatarSize, number> = { xs: 20, sm: 28, md: 36, lg: 56 };
const TEXT_CLASS: Record<PersonAvatarSize, string> = {
  xs: 'text-[10px]', sm: 'text-xs', md: 'text-sm', lg: 'text-base',
};

function initialsOf(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}

/**
 * Person avatar with a two-tier fallback: the profile image (avatar_url /
 * profile_picture_url) if present, else an initials chip. Mirrors CompanyLogo
 * so people and companies render consistently across the app.
 */
export function PersonAvatar({
  name, src, size = 'sm', className,
}: {
  name?: string | null;
  src?: string | null;
  size?: PersonAvatarSize;
  className?: string;
}) {
  const px = SIZE_PX[size];
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: px, height: px }}
        className={cn('rounded-full object-cover bg-muted border border-border shrink-0', className)}
      />
    );
  }
  return (
    <div
      style={{ width: px, height: px }}
      className={cn('flex items-center justify-center rounded-full bg-primary/10 text-primary font-semibold shrink-0', TEXT_CLASS[size], className)}
      aria-label={name ?? ''}
      title={name ?? ''}
    >
      {initialsOf(name)}
    </div>
  );
}
