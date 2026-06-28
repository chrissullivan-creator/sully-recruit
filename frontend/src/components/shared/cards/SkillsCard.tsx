import { ReactNode } from 'react';
import { Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/shared/SectionCard';
import { EmptyState } from '@/components/shared/EmptyState';

export interface SkillChip {
  label: ReactNode;
  /** Tints the chip gold for emphasis (e.g. top/required skills). */
  accent?: boolean;
  onClick?: () => void;
}

interface SkillsCardProps {
  title?: ReactNode;
  actions?: ReactNode;
  skills: SkillChip[];
  emptyLabel?: string;
  className?: string;
}

/**
 * SkillsCard — a chip cloud of skills / tags / functions. Uniform chip style
 * (matching the detail-header tag row); `accent` tints a chip gold.
 */
export function SkillsCard({
  title = 'Skills', actions, skills, emptyLabel = 'No skills on file', className,
}: SkillsCardProps) {
  return (
    <SectionCard title={title} icon={<Tag className="h-4 w-4" />} actions={actions} className={className}>
      {skills.length === 0 ? (
        <EmptyState icon={Tag} title={emptyLabel} className="py-8" />
      ) : (
        <div className="flex flex-wrap gap-2">
          {skills.map((s, i) => (
            <span
              key={i}
              onClick={s.onClick}
              className={cn(
                'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                s.accent
                  ? 'border-accent/30 bg-accent/10 text-accent'
                  : 'border-card-border bg-muted/40 text-foreground',
                s.onClick && 'cursor-pointer transition-colors hover:border-primary/40',
              )}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
