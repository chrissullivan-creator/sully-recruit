import { Mail, Phone, FileText, Linkedin, UserPlus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActivityFeed } from '@/hooks/useData';
import { formatDistanceToNow } from 'date-fns';

const TYPE_CONFIG: Record<string, { icon: any; color: string }> = {
  email_sent:    { icon: Mail,     color: 'bg-info/10 text-info'           },
  sms_sent:      { icon: Phone,    color: 'bg-success/10 text-success'     },
  linkedin_sent: { icon: Linkedin, color: 'bg-blue-500/10 text-blue-400'  },
  note_added:    { icon: FileText, color: 'bg-muted text-muted-foreground' },
  enrolled:      { icon: UserPlus, color: 'bg-accent/10 text-accent'       },
  call_made:     { icon: Phone,    color: 'bg-success/10 text-success'     },
  stage_changed: { icon: FileText, color: 'bg-warning/10 text-warning'     },
};

export function ActivityFeed() {
  const { data: activities = [], isLoading } = useActivityFeed(10);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading activity...
      </div>
    );
  }

  if (!activities.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No recent activity yet. Send some emails, make some placements.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {activities.map((activity, index) => {
        const cfg = TYPE_CONFIG[activity.type] ?? TYPE_CONFIG.note_added;
        const Icon = cfg.icon;
        return (
          <div key={activity.id} className="flex gap-3 animate-fade-in" style={{ animationDelay: `${index * 30}ms` }}>
            <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', cfg.color)}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground leading-snug">{activity.description}</p>
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
