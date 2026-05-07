import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Clock, MapPin, Video, ExternalLink, Users as UsersIcon,
  Phone, FileText, ArrowUpRight, Sparkles,
} from 'lucide-react';
import { format, parseISO, differenceInMinutes } from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * Detail dialog for a calendar meeting.
 *
 * Past meetings: shows attendee list + any AI call-note recaps that match
 * one of the attendees within a ±2h window of the meeting start. Recaps
 * are mined from ai_call_notes (Deepgram transcripts + Joe's extraction)
 * so post-meeting, the user can revisit the AI-summarised takeaway with
 * a click rather than digging through call logs.
 *
 * Upcoming meetings: shows attendee list + recent activity per attendee
 * (last contact / last response / status) for prep.
 *
 * Attendees are clickable and navigate to /candidates/:id or
 * /contacts/:id depending on entity_type stored on meeting_attendees.
 */

export interface MeetingTask {
  id: string;
  title: string;
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  due_date: string | null;
  location: string | null;
  meeting_url: string | null;
  external_id: string | null;
  status: string | null;
  assigned_to: string | null;
}

interface AttendeeRow {
  task_id: string;
  entity_type: 'candidate' | 'contact';
  entity_id: string;
  name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  status: string | null;
  last_contacted_at: string | null;
  last_responded_at: string | null;
}

interface CallNoteRow {
  id: string;
  candidate_id: string | null;
  contact_id: string | null;
  call_started_at: string | null;
  call_duration_seconds: number | null;
  call_direction: string | null;
  ai_summary: string | null;
  ai_action_items: string | null;
  recording_url: string | null;
}

function useMeetingDetails(task: MeetingTask | null) {
  return useQuery({
    queryKey: ['meeting_details', task?.id],
    enabled: !!task?.id,
    queryFn: async (): Promise<{ attendees: AttendeeRow[]; callNotes: CallNoteRow[] }> => {
      if (!task) return { attendees: [], callNotes: [] };

      // Attendees
      const { data: links } = await supabase
        .from('meeting_attendees')
        .select('task_id, entity_type, entity_id')
        .eq('task_id', task.id);

      const candidateIds = (links ?? []).filter((l: any) => l.entity_type === 'candidate').map((l: any) => l.entity_id);
      const contactIds = (links ?? []).filter((l: any) => l.entity_type === 'contact').map((l: any) => l.entity_id);

      const [peopleRes, contactsRes] = await Promise.all([
        candidateIds.length
          ? supabase.from('people').select('id, full_name, email:primary_email, current_title, current_company, status, last_contacted_at, last_responded_at').in('id', candidateIds)
          : Promise.resolve({ data: [] as any[] }),
        contactIds.length
          ? supabase.from('contacts').select('id, full_name, email, current_title, current_company, status, last_contacted_at, last_responded_at').in('id', contactIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const peopleById = new Map((peopleRes.data ?? []).map((p: any) => [p.id, p]));
      const contactsById = new Map((contactsRes.data ?? []).map((c: any) => [c.id, c]));

      const attendees: AttendeeRow[] = (links ?? []).map((l: any) => {
        const src = l.entity_type === 'candidate' ? peopleById.get(l.entity_id) : contactsById.get(l.entity_id);
        return {
          task_id: l.task_id,
          entity_type: l.entity_type,
          entity_id: l.entity_id,
          name: src?.full_name ?? null,
          email: src?.email ?? null,
          current_title: src?.current_title ?? null,
          current_company: src?.current_company ?? null,
          status: src?.status ?? null,
          last_contacted_at: src?.last_contacted_at ?? null,
          last_responded_at: src?.last_responded_at ?? null,
        };
      });

      // Call notes — only relevant for past meetings within ±2h of start
      const allIds = [...candidateIds, ...contactIds];
      let callNotes: CallNoteRow[] = [];
      const start = task.start_time ? parseISO(task.start_time) : null;
      const isPast = start ? start < new Date() : false;
      if (isPast && allIds.length && start) {
        const windowStart = new Date(start.getTime() - 2 * 3600_000).toISOString();
        const windowEnd = new Date(start.getTime() + 4 * 3600_000).toISOString();
        const orFilter = [
          candidateIds.length ? `candidate_id.in.(${candidateIds.join(',')})` : null,
          contactIds.length ? `contact_id.in.(${contactIds.join(',')})` : null,
        ].filter(Boolean).join(',');
        if (orFilter) {
          const { data } = await supabase
            .from('ai_call_notes')
            .select('id, candidate_id, contact_id, call_started_at, call_duration_seconds, call_direction, ai_summary, ai_action_items, recording_url')
            .or(orFilter)
            .gte('call_started_at', windowStart)
            .lte('call_started_at', windowEnd)
            .order('call_started_at', { ascending: true });
          callNotes = (data ?? []) as CallNoteRow[];
        }
      }

      return { attendees, callNotes };
    },
    staleTime: 30_000,
  });
}

export function MeetingDetailDialog({
  task,
  onOpenChange,
}: {
  task: MeetingTask | null;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const open = !!task;
  const { data, isLoading } = useMeetingDetails(task);

  const start = task?.start_time ? parseISO(task.start_time) : null;
  const end = task?.end_time ? parseISO(task.end_time) : null;
  const isPast = start ? start < new Date() : false;
  const durationMin = start && end ? differenceInMinutes(end, start) : null;

  const cleanedTitle = useMemo(
    () => (task?.title ?? '').replace(/^📅\s*/, '').trim() || 'Meeting',
    [task?.title],
  );

  if (!task) return null;

  const goToAttendee = (a: AttendeeRow) => {
    onOpenChange(false);
    if (a.entity_type === 'candidate') navigate(`/candidates/${a.entity_id}`);
    else navigate(`/contacts/${a.entity_id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <span className="truncate">{cleanedTitle}</span>
            {isPast ? (
              <Badge variant="outline" className="text-[10px] border-muted-foreground/30 text-muted-foreground">Past</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] border-emerald/40 text-emerald-dark">Upcoming</Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-3 text-xs pt-1">
            {start && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {format(start, 'EEE, MMM d • h:mm a')}
                {end && ` – ${format(end, 'h:mm a')}`}
                {durationMin != null && ` (${durationMin}m)`}
              </span>
            )}
            {task.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {task.location}
              </span>
            )}
            {task.meeting_url && (
              <a
                href={task.meeting_url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-emerald hover:text-emerald-dark"
              >
                <Video className="h-3 w-3" /> Join <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {task.external_id && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald/30 text-emerald-dark">Outlook</Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {task.description && task.description.trim() && (
            <div className="text-sm text-foreground/80 whitespace-pre-wrap mb-4 px-1">
              {task.description}
            </div>
          )}

          {/* Attendees */}
          <section className="space-y-2 mb-4">
            <h3 className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <UsersIcon className="h-3 w-3" /> Attendees
              <span className="text-[10px] text-muted-foreground/70">
                {data?.attendees.length ?? 0}
              </span>
            </h3>
            {isLoading ? (
              <p className="text-xs text-muted-foreground italic">Loading…</p>
            ) : (data?.attendees ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No matched attendees on this event.</p>
            ) : (
              <div className="space-y-1.5">
                {data!.attendees.map((a) => (
                  <button
                    key={`${a.entity_type}-${a.entity_id}`}
                    onClick={() => goToAttendee(a)}
                    className={cn(
                      'w-full text-left rounded-md border border-card-border bg-white px-3 py-2 hover:border-emerald/40 hover:bg-emerald-light/10 transition-colors group',
                      'flex items-center justify-between gap-3',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{a.name || a.email || 'Unknown'}</span>
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 capitalize">{a.entity_type}</Badge>
                        {a.status && <Badge variant="secondary" className="text-[9px] capitalize">{a.status.replace(/_/g, ' ')}</Badge>}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {[a.current_title, a.current_company].filter(Boolean).join(' · ') || a.email || ''}
                      </div>
                      {!isPast && (a.last_contacted_at || a.last_responded_at) && (
                        <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                          {a.last_responded_at && `Last reply ${format(parseISO(a.last_responded_at), 'MMM d')}`}
                          {a.last_responded_at && a.last_contacted_at && ' · '}
                          {a.last_contacted_at && `Last reach ${format(parseISO(a.last_contacted_at), 'MMM d')}`}
                        </div>
                      )}
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-emerald-dark shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Past meeting recaps from ai_call_notes */}
          {isPast && (
            <section className="space-y-2 mb-4">
              <h3 className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" /> Meeting recap
                <span className="text-[10px] text-muted-foreground/70">
                  AI summaries from calls within ±2h
                </span>
              </h3>
              {isLoading ? (
                <p className="text-xs text-muted-foreground italic">Loading…</p>
              ) : (data?.callNotes ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No call recordings found around this meeting time.</p>
              ) : (
                <div className="space-y-2">
                  {data!.callNotes.map((n) => {
                    const att = data!.attendees.find(
                      (a) => (n.candidate_id && a.entity_id === n.candidate_id)
                          || (n.contact_id && a.entity_id === n.contact_id),
                    );
                    const startedAt = n.call_started_at ? parseISO(n.call_started_at) : null;
                    const dur = n.call_duration_seconds
                      ? `${Math.floor(n.call_duration_seconds / 60)}m ${n.call_duration_seconds % 60}s`
                      : '';
                    return (
                      <div key={n.id} className="rounded-md border border-emerald/20 bg-emerald-light/10 px-3 py-2">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2 text-[11px] text-emerald-dark font-medium">
                            <Phone className="h-3 w-3" />
                            {att?.name ?? 'Unknown'}
                            {n.call_direction && <span className="text-muted-foreground/70">· {n.call_direction}</span>}
                            {dur && <span className="text-muted-foreground/70">· {dur}</span>}
                          </div>
                          {startedAt && (
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {format(startedAt, 'h:mm a')}
                            </span>
                          )}
                        </div>
                        {n.ai_summary && (
                          <p className="text-xs text-foreground/80 whitespace-pre-wrap">{n.ai_summary}</p>
                        )}
                        {n.ai_action_items && n.ai_action_items !== '- None' && (
                          <div className="mt-2 pt-2 border-t border-emerald/20">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-dark mb-1">Action items</p>
                            <p className="text-xs text-foreground/80 whitespace-pre-wrap">{n.ai_action_items}</p>
                          </div>
                        )}
                        {n.recording_url && (
                          <div className="mt-2 pt-2 border-t border-emerald/20">
                            <a
                              href={n.recording_url} target="_blank" rel="noopener noreferrer"
                              className="text-[11px] inline-flex items-center gap-1 text-emerald hover:text-emerald-dark"
                            >
                              <FileText className="h-3 w-3" /> Recording
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </ScrollArea>

        <div className="flex justify-end pt-2 border-t border-card-border">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
