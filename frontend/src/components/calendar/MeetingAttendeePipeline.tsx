import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { FileText, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { WithdrawnReasonDialog } from '@/components/send-outs/WithdrawnReasonDialog';
import { stageToCanonical } from '@/lib/pipeline';
import { SEND_OUT_STAGES } from '@/components/job-detail/SendOutCard';

/**
 * Inline pipeline strip for one meeting attendee: their latest résumé +
 * every send-out (job · company) with a stage dropdown that moves the
 * send-out's stage right from the meeting dialog. Mirrors SendOutCard's
 * stage-change behavior (terminal "withdrawn" stages defer to the
 * WithdrawnReasonDialog so the responsible party is recorded).
 */
export function MeetingAttendeePipeline({ candidateId }: { candidateId: string }) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<{ id: string; stage: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['meeting_attendee_pipeline', candidateId],
    enabled: !!candidateId,
    staleTime: 30_000,
    queryFn: async () => {
      const [soRes, resRes] = await Promise.all([
        supabase
          .from('send_outs')
          .select('id, stage, created_at, job:jobs(id, title, company_name)')
          .eq('candidate_id', candidateId)
          .order('created_at', { ascending: false }),
        supabase
          .from('resumes')
          .select('file_path, created_at')
          .eq('candidate_id', candidateId)
          .order('created_at', { ascending: false })
          .limit(1),
      ]);
      let resumeUrl: string | null = null;
      const filePath = (resRes.data as any)?.[0]?.file_path;
      if (filePath) {
        const { data: signed } = await supabase.storage.from('resumes').createSignedUrl(filePath, 3600);
        resumeUrl = signed?.signedUrl ?? null;
      }
      return { sendOuts: (soRes.data ?? []) as any[], resumeUrl };
    },
  });

  const applyStage = async (sendOutId: string, newStage: string, party?: string, reason?: string) => {
    setChanging(sendOutId);
    try {
      const updates: any = { stage: newStage };
      if (newStage === 'interviewing') updates.interview_at = new Date().toISOString();
      else if (newStage === 'offer') updates.offer_at = new Date().toISOString();
      else if (newStage === 'placed') updates.placed_at = new Date().toISOString();
      if (party) updates.withdrawn_by_party = party;
      if (reason && reason.trim()) updates.withdrawn_reason = reason.trim();
      const { error } = await supabase.from('send_outs').update(updates).eq('id', sendOutId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['meeting_attendee_pipeline', candidateId] });
      queryClient.invalidateQueries({ queryKey: ['send_outs'] });
      toast.success(`Stage updated to ${SEND_OUT_STAGES.find(s => s.value === newStage)?.label ?? newStage}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setChanging(null);
    }
  };

  const onStageChange = (sendOutId: string, newStage: string) => {
    if (stageToCanonical(newStage) === 'withdrawn') {
      setRejectFor({ id: sendOutId, stage: newStage });
      return;
    }
    applyStage(sendOutId, newStage);
  };

  if (isLoading) {
    return <p className="text-[11px] text-muted-foreground/70 italic mt-1">Loading pipeline…</p>;
  }

  const sendOuts = data?.sendOuts ?? [];
  if (!data?.resumeUrl && sendOuts.length === 0) return null;

  return (
    <div className="mt-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
      {data?.resumeUrl && (
        <a
          href={data.resumeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-emerald hover:text-emerald-dark"
        >
          <FileText className="h-3 w-3" /> Résumé <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}

      {sendOuts.length > 0 && (
        <div className="space-y-1">
          {sendOuts.map((so) => (
            <div
              key={so.id}
              className="flex items-center justify-between gap-2 rounded border border-card-border bg-muted/20 px-2 py-1"
            >
              <span className="text-[11px] truncate min-w-0">
                {so.job?.title ?? 'Role'}
                {so.job?.company_name ? ` · ${so.job.company_name}` : ''}
              </span>
              <Select
                value={so.stage ?? 'submitted'}
                onValueChange={(v) => onStageChange(so.id, v)}
                disabled={changing === so.id}
              >
                <SelectTrigger className="h-6 w-auto min-w-[110px] border-card-border text-[11px] rounded px-1.5 py-0 gap-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEND_OUT_STAGES.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-[11px]">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      <WithdrawnReasonDialog
        open={!!rejectFor}
        onOpenChange={(o) => { if (!o) setRejectFor(null); }}
        onConfirm={(party, reason) => {
          if (rejectFor) applyStage(rejectFor.id, rejectFor.stage, party, reason);
          setRejectFor(null);
        }}
      />
    </div>
  );
}
