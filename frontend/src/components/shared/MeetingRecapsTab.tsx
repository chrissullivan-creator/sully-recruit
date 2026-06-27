import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  PhoneIncoming, PhoneOutgoing, Clock, FileText, ListChecks,
  DollarSign, ChevronDown, ChevronUp, Martini, Wand2, Loader2, PhoneCall,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { invalidatePersonScope } from '@/lib/invalidate';
import { cn } from '@/lib/utils';

interface MeetingRecapsTabProps {
  entityId: string;
  entityType: 'candidate' | 'contact';
  personName?: string | null;
}

type AiNote = any;
type CallLog = any;

interface Recap {
  key: string;
  isLatest: boolean;
  callLog?: CallLog;
  aiNote?: AiNote;
  startedAt: string | null;
  direction: 'inbound' | 'outbound';
  durationSeconds: number | null;
  phoneNumber: string | null;
  audioUrl: string | null;
  summary: string | null;
  actionItems: string | null;
  notes: string | null;
  transcript: string | null;
  reasonForLeaving: string | null;
  currentBase: number | null;
  currentBonus: number | null;
  targetBase: number | null;
  targetBonus: number | null;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--:--';
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function buildRecaps(callLogs: CallLog[], aiNotes: AiNote[]): Recap[] {
  const recaps: Recap[] = [];

  for (const cl of callLogs) {
    const aiNote = aiNotes.find(
      (n: AiNote) =>
        n.call_log_id === cl.id ||
        (cl.external_call_id && n.external_call_id === cl.external_call_id),
    );
    if (!aiNote && !cl.audio_url) continue;
    recaps.push({
      key: `cl-${cl.id}`,
      isLatest: false,
      callLog: cl,
      aiNote,
      startedAt: cl.started_at ?? aiNote?.call_started_at ?? null,
      direction: (cl.direction || 'outbound') as 'inbound' | 'outbound',
      durationSeconds: cl.duration_seconds ?? aiNote?.call_duration_seconds ?? null,
      phoneNumber: cl.phone_number ?? aiNote?.phone_number ?? null,
      audioUrl: aiNote?.recording_url ?? cl.audio_url ?? null,
      summary: aiNote?.ai_summary ?? cl.summary ?? null,
      actionItems: aiNote?.ai_action_items ?? null,
      notes: aiNote?.extracted_notes ?? null,
      transcript: aiNote?.transcript ?? null,
      reasonForLeaving: aiNote?.extracted_reason_for_leaving ?? null,
      currentBase: aiNote?.extracted_current_base ?? null,
      currentBonus: aiNote?.extracted_current_bonus ?? null,
      targetBase: aiNote?.extracted_target_base ?? null,
      targetBonus: aiNote?.extracted_target_bonus ?? null,
    });
  }

  // Orphan AI notes — no matching call log row
  for (const note of aiNotes) {
    const hasMatchingLog = callLogs.some(
      (cl) =>
        cl.id === note.call_log_id ||
        (cl.external_call_id && cl.external_call_id === note.external_call_id),
    );
    if (hasMatchingLog) continue;
    recaps.push({
      key: `note-${note.id}`,
      isLatest: false,
      aiNote: note,
      startedAt: note.call_started_at ?? note.created_at ?? null,
      direction: (note.call_direction || 'outbound') as 'inbound' | 'outbound',
      durationSeconds: note.call_duration_seconds ?? null,
      phoneNumber: note.phone_number ?? null,
      audioUrl: note.recording_url ?? null,
      summary: note.ai_summary ?? null,
      actionItems: note.ai_action_items ?? null,
      notes: note.extracted_notes ?? null,
      transcript: note.transcript ?? null,
      reasonForLeaving: note.extracted_reason_for_leaving ?? null,
      currentBase: note.extracted_current_base ?? null,
      currentBonus: note.extracted_current_bonus ?? null,
      targetBase: note.extracted_target_base ?? null,
      targetBonus: note.extracted_target_bonus ?? null,
    });
  }

  recaps.sort((a, b) => {
    const at = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bt - at;
  });

  if (recaps.length > 0) recaps[0].isLatest = true;

  return recaps;
}

function hasIntel(r: Recap): boolean {
  return (
    r.currentBase != null ||
    r.currentBonus != null ||
    r.targetBase != null ||
    r.targetBonus != null ||
    !!r.reasonForLeaving ||
    !!r.notes
  );
}

export function MeetingRecapsTab({ entityId, entityType, personName }: MeetingRecapsTabProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState<string | null>(null);

  const { data: callLogs = [], isLoading: loadingLogs } = useQuery({
    queryKey: ['call_logs', entityType, entityId, 'recaps'],
    enabled: !!entityId,
    queryFn: async () => {
      let query = supabase.from('call_logs').select('*').order('started_at', { ascending: false });
      if (entityType === 'candidate') {
        query = query.eq('candidate_id', entityId);
      } else {
        query = query.eq('linked_entity_id', entityId).eq('linked_entity_type', 'contact');
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as any[];
    },
  });

  const { data: aiNotes = [], isLoading: loadingNotes } = useQuery({
    queryKey: ['ai_call_notes', entityType, entityId, 'recaps'],
    enabled: !!entityId,
    queryFn: async () => {
      const column = entityType === 'candidate' ? 'candidate_id' : 'contact_id';
      const { data, error } = await supabase
        .from('ai_call_notes')
        .select('*')
        .eq(column, entityId)
        .order('updated_candidates_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const isLoading = loadingLogs || loadingNotes;
  const recaps = buildRecaps(callLogs as any[], aiNotes as any[]);

  async function applyRecapToProfile(r: Recap) {
    if (!hasIntel(r)) {
      toast.info('No extracted intel on this recap to apply');
      return;
    }
    try {
      setApplying(r.key);
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (r.currentBase != null) updates.current_base_comp = r.currentBase;
      if (r.currentBonus != null) updates.current_bonus_comp = r.currentBonus;
      if (r.targetBase != null) updates.target_base_comp = r.targetBase;
      if (r.targetBonus != null) updates.target_bonus_comp = r.targetBonus;
      if (entityType === 'candidate') {
        if (r.reasonForLeaving) updates.reason_for_leaving = r.reasonForLeaving;
        if (r.notes) updates.back_of_resume_notes = r.notes;
      }

      const { error } = await supabase.from('people').update(updates).eq('id', entityId);
      if (error) throw error;

      toast.success('Applied recap intel to profile');
      invalidatePersonScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to apply recap');
    } finally {
      setApplying(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading meeting recaps...</span>
      </div>
    );
  }

  if (recaps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <PhoneCall className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm font-medium mb-1">No meeting recaps yet</p>
        <p className="text-xs text-muted-foreground">
          Recaps appear here once a RingCentral call with this {entityType} is recorded and transcribed.
        </p>
      </div>
    );
  }

  const latest = recaps[0];
  const latestHasIntel = hasIntel(latest);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Martini className="h-5 w-5 text-accent" />
          <h2 className="text-base font-semibold">Meeting Recaps</h2>
          <span className="text-xs text-muted-foreground">({recaps.length})</span>
        </div>
        {latestHasIntel && (
          <Button
            size="sm"
            variant="gold"
            onClick={() => applyRecapToProfile(latest)}
            disabled={applying === latest.key}
          >
            {applying === latest.key ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Wand2 className="h-3.5 w-3.5 mr-1" />
            )}
            Sync profile from latest call
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {recaps.map((r) => {
          const isOutbound = r.direction === 'outbound';
          const startedAtStr = r.startedAt
            ? format(new Date(r.startedAt), 'MMM d, yyyy · h:mm a')
            : '—';
          const isExpanded = !!expanded[r.key];

          return (
            <div
              key={r.key}
              className={cn(
                'rounded-xl border bg-white',
                r.isLatest ? 'border-accent/40 shadow-sm' : 'border-card-border',
              )}
            >
              <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                      isOutbound ? 'bg-info/10 text-info' : 'bg-success/10 text-success',
                    )}
                  >
                    {isOutbound ? <PhoneOutgoing className="h-4 w-4" /> : <PhoneIncoming className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">
                        {isOutbound ? 'Outbound' : 'Inbound'} Call
                        {personName ? ` — ${personName}` : ''}
                      </p>
                      {r.isLatest && (
                        <Badge variant="secondary" className="text-[9px] bg-accent/15 text-accent">
                          Latest
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {r.phoneNumber ? `${r.phoneNumber} · ` : ''}
                      {startedAtStr} · <Clock className="h-3 w-3 inline" /> {formatDuration(r.durationSeconds)}
                    </p>
                  </div>
                </div>
                {hasIntel(r) && (
                  <Button
                    size="sm"
                    variant="gold-outline"
                    onClick={() => applyRecapToProfile(r)}
                    disabled={applying === r.key}
                  >
                    {applying === r.key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5 mr-1" />
                    )}
                    Apply to profile
                  </Button>
                )}
              </div>

              <div className="px-5 py-4 space-y-4">
                {r.audioUrl && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Recording
                    </p>
                    <audio controls className="w-full h-8" preload="none">
                      <source src={r.audioUrl} />
                    </audio>
                  </div>
                )}

                {r.summary ? (
                  <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="h-4 w-4 text-accent" />
                      <p className="text-xs font-semibold text-accent uppercase tracking-wide">
                        Joe's Summary
                      </p>
                    </div>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                      {r.summary}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No AI summary yet — transcription may still be processing.
                  </p>
                )}

                {r.actionItems && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <ListChecks className="h-4 w-4 text-foreground" />
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Action Items
                      </p>
                    </div>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                      {r.actionItems}
                    </p>
                  </div>
                )}

                {r.notes && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      Back-of-Resume Notes
                    </p>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                      {r.notes}
                    </p>
                  </div>
                )}

                {(r.currentBase != null ||
                  r.currentBonus != null ||
                  r.targetBase != null ||
                  r.targetBonus != null ||
                  r.reasonForLeaving) && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <DollarSign className="h-4 w-4 text-foreground" />
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Extracted Intel
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {r.currentBase != null && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">
                            Current Base
                          </p>
                          <p className="text-sm text-foreground">
                            ${Number(r.currentBase).toLocaleString()}
                          </p>
                        </div>
                      )}
                      {r.currentBonus != null && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">
                            Current Bonus
                          </p>
                          <p className="text-sm text-foreground">
                            ${Number(r.currentBonus).toLocaleString()}
                          </p>
                        </div>
                      )}
                      {r.targetBase != null && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">
                            Target Base
                          </p>
                          <p className="text-sm text-foreground">
                            ${Number(r.targetBase).toLocaleString()}
                          </p>
                        </div>
                      )}
                      {r.targetBonus != null && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">
                            Target Bonus
                          </p>
                          <p className="text-sm text-foreground">
                            ${Number(r.targetBonus).toLocaleString()}
                          </p>
                        </div>
                      )}
                    </div>
                    {r.reasonForLeaving && (
                      <div className="mt-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">
                          Reason for Leaving
                        </p>
                        <p className="text-sm text-foreground leading-relaxed">
                          {r.reasonForLeaving}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {r.transcript && (
                  <div className="rounded-lg border border-border">
                    <button
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [r.key]: !prev[r.key] }))
                      }
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
                    >
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Full Transcript
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-4 max-h-96 overflow-y-auto">
                        <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap font-mono">
                          {r.transcript}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
