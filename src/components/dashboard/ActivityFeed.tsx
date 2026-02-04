import { Mail, Phone, MessageSquare, FileText, Linkedin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { mockActivities } from '@/data/mockData';
import { formatDistanceToNow } from 'date-fns';

const activityIcons = {
  email_sent: Mail,
  call_made: Phone,
  meeting_scheduled: FileText,
  note_added: FileText,
  stage_changed: FileText,
  linkedin_sent: Linkedin,
};

const activityColors = {
  email_sent: 'bg-info/10 text-info',
  call_made: 'bg-success/10 text-success',
  meeting_scheduled: 'bg-accent/10 text-accent',
  note_added: 'bg-muted text-muted-foreground',
  stage_changed: 'bg-warning/10 text-warning',
  linkedin_sent: 'bg-info/10 text-info',
};

export function ActivityFeed() {
  return (
    <div className="space-y-4">
      {mockActivities.map((activity, index) => {
        const Icon = activityIcons[activity.type];
        return (
          <div key={activity.id} className="flex gap-3 animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
            <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', activityColors[activity.type])}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground">{activity.description}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatDistanceToNow(activity.timestamp, { addSuffix: true })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
