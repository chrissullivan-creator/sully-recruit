import { Mail, Phone, MessageSquare, Linkedin, StickyNote, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Communication } from '@/types';
import { format } from 'date-fns';

interface CommunicationTimelineProps {
  communications: Communication[];
}

const channelIcons: Record<Communication['type'], React.ElementType> = {
  email: Mail,
  call: Phone,
  sms: MessageSquare,
  linkedin: Linkedin,
  note: StickyNote,
};

const channelLabels: Record<Communication['type'], string> = {
  email: 'Email',
  call: 'Call',
  sms: 'SMS',
  linkedin: 'LinkedIn',
  note: 'Note',
};

export function CommunicationTimeline({ communications }: CommunicationTimelineProps) {
  const sorted = [...communications].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
        <p className="text-sm">No communications yet</p>
      </div>
    );
  }

  return (
    <div className="relative space-y-0">
      {sorted.map((comm, idx) => {
        const Icon = channelIcons[comm.type];
        const isLast = idx === sorted.length - 1;
        const isInbound = comm.direction === 'inbound';

        return (
          <div key={comm.id} className="relative flex gap-4 pb-6">
            {/* Vertical connector line */}
            {!isLast && (
              <div className="absolute left-[17px] top-10 bottom-0 w-px bg-border" />
            )}

            {/* Icon circle */}
            <div
              className={cn(
                'relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border',
                comm.type === 'call' && 'bg-accent/10 border-accent/30 text-accent',
                comm.type === 'email' && 'bg-info/10 border-info/30 text-info',
                comm.type === 'linkedin' && 'bg-[hsl(199_89%_48%/0.1)] border-[hsl(199_89%_48%/0.3)] text-[hsl(199_89%_48%)]',
                comm.type === 'sms' && 'bg-success/10 border-success/30 text-success',
                comm.type === 'note' && 'bg-muted border-border text-muted-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-foreground">
                  {channelLabels[comm.type]}
                </span>
                <span className={cn(
                  'inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded',
                  isInbound 
                    ? 'bg-success/10 text-success' 
                    : 'bg-accent/10 text-accent'
                )}>
                  {isInbound ? <ArrowDownLeft className="h-2.5 w-2.5" /> : <ArrowUpRight className="h-2.5 w-2.5" />}
                  {isInbound ? 'Inbound' : 'Outbound'}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {format(comm.timestamp, 'MMM d, h:mm a')}
                </span>
              </div>

              {comm.subject && (
                <p className="text-sm font-medium text-foreground/80 mb-1">{comm.subject}</p>
              )}
              <p className="text-sm text-muted-foreground leading-relaxed">{comm.content}</p>

              {/* Call-specific details */}
              {comm.type === 'call' && comm.duration && (
                <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Duration: {Math.floor(comm.duration / 60)}m {comm.duration % 60}s</span>
                  {comm.audioUrl && (
                    <button className="text-accent hover:underline">Play Recording</button>
                  )}
                </div>
              )}

              {/* AI Summary */}
              {comm.summary && (
                <div className="mt-2 rounded-md bg-accent/5 border border-accent/10 px-3 py-2">
                  <p className="text-[10px] font-medium text-accent uppercase tracking-wide mb-1">AI Summary</p>
                  <p className="text-xs text-muted-foreground">{comm.summary}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
