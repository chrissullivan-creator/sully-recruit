import { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { SectionCard } from '@/components/shared/SectionCard';
import { ActivityTimeline, type TimelineGroup } from '@/components/shared/ActivityTimeline';
import { EmptyState } from '@/components/shared/EmptyState';

interface ActivityCardProps {
  title?: ReactNode;
  /** Already-grouped timeline events (Today / Yesterday / …). */
  groups: TimelineGroup[];
  actions?: ReactNode;
  emptyLabel?: string;
  className?: string;
}

/**
 * ActivityCard — a titled SectionCard wrapping the shared ActivityTimeline,
 * with a built-in empty state. Pass already-grouped events; no fetching here.
 */
export function ActivityCard({
  title = 'Activity', groups, actions, emptyLabel = 'No activity yet', className,
}: ActivityCardProps) {
  const hasEvents = groups.some((g) => g.events.length > 0);
  return (
    <SectionCard title={title} icon={<Activity className="h-4 w-4" />} actions={actions} className={className}>
      {hasEvents ? (
        <ActivityTimeline groups={groups} />
      ) : (
        <EmptyState icon={Activity} title={emptyLabel} className="py-8" />
      )}
    </SectionCard>
  );
}
