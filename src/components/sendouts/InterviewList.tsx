import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useContacts } from '@/hooks/useData';
import {
  INTERVIEW_TYPE_LABEL,
  INTERVIEW_OUTCOME_LABEL,
  INTERVIEW_OUTCOME_BADGE,
  type InterviewRow,
  type InterviewType,
  type InterviewOutcome,
} from '@/components/sendouts/interviewTypes';
import { InterviewModal } from '@/components/sendouts/InterviewModal';
import { InterviewDebrief } from '@/components/sendouts/InterviewDebrief';
import { format } from 'date-fns';
import { Plus, Calendar, Clock, MapPin, Video, User, Loader2, MessageSquareQuote } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InterviewListProps {
  sendOutId: string;
}

function useInterviews(sendOutId: string) {
  return useQuery({
    queryKey: ['interviews', sendOutId],
    enabled: !!sendOutId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('interviews')
        .select('*')
        .eq('send_out_id', sendOutId)
        .order('round', { ascending: true })
        .order('scheduled_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as InterviewRow[];
    },
  });
}

export function InterviewList({ sendOutId }: InterviewListProps) {
  const { data: interviews = [], isLoading } = useInterviews(sendOutId);
  const { data: contacts = [] } = useContacts();
  const qc = useQueryClient();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<InterviewRow | null>(null);
  const [debriefing, setDebriefing] = useState<InterviewRow | null>(null);

  const contactById = Object.fromEntries((contacts as any[]).map((c) => [c.id, c]));

  const nextRound = Math.max(0, ...interviews.map((i) => i.round)) + 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">
          {interviews.length} interview{interviews.length === 1 ? '' : 's'}
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 bg-emerald-700 hover:bg-emerald-800 text-white"
          onClick={() => { setEditing(null); setModalOpen(true); }}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Schedule Interview
        </Button>
      </div>

      {isLoading && (
        <div className="py-6 text-center text-muted-foreground text-xs">
          <Loader2 className="h-4 w-4 inline animate-spin mr-1" /> Loading…
        </div>
      )}

      {!isLoading && interviews.length === 0 && (
        <div className="py-6 text-center text-xs text-muted-foreground italic">
          No interviews scheduled yet.
        </div>
      )}

      <div className="space-y-2">
        {interviews.map((iv) => {
          const interviewer = iv.primary_interviewer_id ? contactById[iv.primary_interviewer_id] : null;
          const outcome = (iv.outcome || 'pending') as InterviewOutcome;
          return (
            <div
              key={iv.id}
              className="rounded-md border border-border bg-background p-3 hover:border-emerald-700/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">R{iv.round}</Badge>
                    <span className="text-sm font-medium">
                      {INTERVIEW_TYPE_LABEL[iv.type as InterviewType] ?? iv.type}
                    </span>
                    {iv.stage && (
                      <span className="text-[11px] text-muted-foreground">· {iv.stage}</span>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {iv.scheduled_at && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(iv.scheduled_at), 'MMM d, yyyy')}
                      </span>
                    )}
                    {iv.scheduled_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(new Date(iv.scheduled_at), 'h:mm a')}
                        {iv.timezone ? ` ${iv.timezone}` : ''}
                      </span>
                    )}
                    {interviewer && (
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {interviewer.full_name || interviewer.email}
                      </span>
                    )}
                    {iv.meeting_link && (
                      <a
                        href={iv.meeting_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-emerald-700 hover:underline"
                      >
                        <Video className="h-3 w-3" /> Join
                      </a>
                    )}
                    {iv.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> {iv.location}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1.5">
                  <Badge variant="outline" className={cn('text-[10px] capitalize', INTERVIEW_OUTCOME_BADGE[outcome])}>
                    {INTERVIEW_OUTCOME_LABEL[outcome]}
                  </Badge>
                </div>
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => { setEditing(iv); setModalOpen(true); }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setDebriefing(iv)}
                >
                  <MessageSquareQuote className="h-3 w-3 mr-1" /> Debrief
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {modalOpen && (
        <InterviewModal
          open={modalOpen}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          sendOutId={sendOutId}
          nextRound={nextRound}
          interview={editing}
          onSaved={() => qc.invalidateQueries({ queryKey: ['interviews', sendOutId] })}
        />
      )}

      {debriefing && (
        <InterviewDebrief
          open={!!debriefing}
          onClose={() => setDebriefing(null)}
          interview={debriefing}
          sendOutId={sendOutId}
          onSaved={() => qc.invalidateQueries({ queryKey: ['interviews', sendOutId] })}
        />
      )}
    </div>
  );
}

export default InterviewList;
