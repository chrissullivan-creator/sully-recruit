import { Mail, Phone, Calendar, StickyNote, ArrowRightLeft, Linkedin } from 'lucide-react';
import type { Activity } from '@/types';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface ActivityHistoryProps {
  activities: Activity[];
}

const activityIcons: Record<Activity['type'], React.ElementType> = {
  email_sent: Mail,
  call_made: Phone,
  meeting_scheduled: Calendar,
  note_added: StickyNote,
  stage_changed: ArrowRightLeft,
  linkedin_sent: Linkedin,
};

const activityColors: Record<Activity['type'], string> = {
  email_sent: 'text-info',
  call_made: 'text-accent',
  meeting_scheduled: 'text-success',
  note_added: 'text-muted-foreground',
  stage_changed: 'text-warning',
  linkedin_sent: 'text-info',
};

export function ActivityHistory({ activities }: ActivityHistoryProps) {
  const sorted = [...activities].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <StickyNote className="h-6 w-6 mb-2 opacity-50" />
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((activity) => {
        const Icon = activityIcons[activity.type];
        return (
          <div key={activity.id} className="flex items-start gap-3 py-2 px-3 rounded-md hover:bg-muted/50 transition-colors">
            <div className={cn('mt-0.5', activityColors[activity.type])}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground">{activity.description}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {format(activity.timestamp, 'MMM d, yyyy · h:mm a')}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
