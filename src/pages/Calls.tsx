import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { mockCommunications } from '@/data/mockData';
import { Phone, PhoneIncoming, PhoneOutgoing, Play, Pause, Search, Clock, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';

const Calls = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);

  const calls = mockCommunications.filter((comm) => comm.type === 'call');

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <MainLayout>
      <PageHeader 
        title="Calls" 
        description="Call history with recordings, transcripts, and AI summaries."
        actions={
          <Button variant="gold">
            <Phone className="h-4 w-4" />
            New Call
          </Button>
        }
      />
      
      <div className="p-8">
        {/* Search */}
        <div className="relative max-w-md mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search calls..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Calls List */}
        <div className="space-y-4">
          {calls.map((call) => (
            <div
              key={call.id}
              className="rounded-lg border border-border bg-card p-5 hover:border-accent/50 transition-all duration-150"
            >
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                  call.direction === 'outbound' ? 'bg-info/10 text-info' : 'bg-success/10 text-success'
                )}>
                  {call.direction === 'outbound' ? (
                    <PhoneOutgoing className="h-5 w-5" />
                  ) : (
                    <PhoneIncoming className="h-5 w-5" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">
                        {call.direction === 'outbound' ? 'Outbound Call' : 'Inbound Call'}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {format(call.timestamp, 'MMM d, yyyy · h:mm a')}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {formatDuration(call.duration)}
                      </span>
                    </div>
                  </div>

                  {/* Notes */}
                  {call.content && (
                    <div className="mt-3 p-3 rounded-lg bg-muted/50">
                      <p className="text-sm text-foreground">{call.content}</p>
                    </div>
                  )}

                  {/* AI Summary */}
                  {call.summary && (
                    <div className="mt-3 p-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2 mb-2">
                        <FileText className="h-3.5 w-3.5 text-accent" />
                        <span className="text-xs font-medium text-accent">AI Summary</span>
                      </div>
                      <p className="text-sm text-foreground">{call.summary}</p>
                    </div>
                  )}

                  {/* Audio Player */}
                  {call.audioUrl && (
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        onClick={() => setPlayingId(playingId === call.id ? null : call.id)}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                          playingId === call.id 
                            ? 'bg-accent text-accent-foreground' 
                            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )}
                      >
                        {playingId === call.id ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4 ml-0.5" />
                        )}
                      </button>
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-accent transition-all duration-300"
                          style={{ width: playingId === call.id ? '35%' : '0%' }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDuration(call.duration)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {calls.length === 0 && (
            <div className="text-center py-12">
              <Phone className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-1">No calls yet</h3>
              <p className="text-sm text-muted-foreground">
                Connect RingCentral to start logging calls automatically.
              </p>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
};

export default Calls;
