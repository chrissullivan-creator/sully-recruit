import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  INTERVIEW_OUTCOMES, INTERVIEW_OUTCOME_LABEL,
  type InterviewRow, type InterviewOutcome,
} from '@/components/sendouts/interviewTypes';
import { Sparkles, Loader2, Save } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InterviewDebriefProps {
  open: boolean;
  onClose: () => void;
  interview: InterviewRow;
  sendOutId: string;
  onSaved?: () => void;
}

const SENTIMENT_STYLES: Record<string, string> = {
  positive: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  neutral:  'bg-slate-100 text-slate-700 border-slate-200',
  negative: 'bg-red-100 text-red-700 border-red-200',
  mixed:    'bg-amber-100 text-amber-700 border-amber-200',
};

export function InterviewDebrief({
  open, onClose, interview, sendOutId, onSaved,
}: InterviewDebriefProps) {
  const [outcome, setOutcome] = useState<InterviewOutcome>((interview.outcome as InterviewOutcome) || 'pending');
  const [completedAt, setCompletedAt] = useState<string>(
    interview.completed_at ? new Date(interview.completed_at).toISOString().slice(0, 16) : '',
  );
  const [debriefNotes, setDebriefNotes] = useState<string>(interview.debrief_notes || '');
  const [aiSummary, setAiSummary] = useState<string | null>(interview.ai_summary);
  const [aiSentiment, setAiSentiment] = useState<string | null>(interview.ai_sentiment);
  const [aiConfidence, setAiConfidence] = useState<number | null>(interview.ai_confidence);
  const [generatingAi, setGeneratingAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [afterSaveAction, setAfterSaveAction] = useState<'offer' | 'rejected' | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setOutcome((interview.outcome as InterviewOutcome) || 'pending');
    setCompletedAt(interview.completed_at ? new Date(interview.completed_at).toISOString().slice(0, 16) : '');
    setDebriefNotes(interview.debrief_notes || '');
    setAiSummary(interview.ai_summary);
    setAiSentiment(interview.ai_sentiment);
    setAiConfidence(interview.ai_confidence);
  }, [interview]);

  const generateSummary = async () => {
    setGeneratingAi(true);
    try {
      // Fetch context needed by the tag-message function.
      const { data: sendOut } = await supabase
        .from('send_out_board')
        .select('candidate_id, job_id, job_title, company_name, candidate_name')
        .eq('id', sendOutId)
        .maybeSingle();

      const { data, error } = await supabase.functions.invoke('tag-message', {
        body: {
          kind: 'interview_debrief',
          candidate_id: (sendOut as any)?.candidate_id,
          job_id: (sendOut as any)?.job_id,
          job_title: (sendOut as any)?.job_title,
          company_name: (sendOut as any)?.company_name,
          candidate_name: (sendOut as any)?.candidate_name,
          round: interview.round,
          type: interview.type,
          outcome,
          debrief_notes: debriefNotes,
        },
      });
      if (error) throw error;

      const d = (data as any) ?? {};
      setAiSummary(d.summary ?? d.ai_summary ?? null);
      setAiSentiment(d.sentiment ?? d.ai_sentiment ?? null);
      const conf =
        typeof d.confidence === 'number'
          ? d.confidence
          : typeof d.ai_confidence === 'number'
          ? d.ai_confidence
          : null;
      setAiConfidence(conf);
      toast.success('AI summary generated');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate summary');
    } finally {
      setGeneratingAi(false);
    }
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const prevOutcome = interview.outcome;
      const { error } = await (supabase as any)
        .from('interviews')
        .update({
          outcome,
          completed_at: completedAt ? new Date(completedAt).toISOString() : null,
          debrief_notes: debriefNotes || null,
          ai_summary: aiSummary,
          ai_sentiment: aiSentiment,
          ai_confidence: aiConfidence,
        })
        .eq('id', interview.id);
      if (error) throw error;

      // Log a stage transition on the interview entity itself.
      if (prevOutcome !== outcome) {
        const { data: userData } = await supabase.auth.getUser();
        await (supabase as any).from('stage_transitions').insert({
          entity_type: 'interview',
          entity_id: interview.id,
          from_stage: prevOutcome,
          to_stage: outcome,
          moved_by_type: 'human',
          moved_by: userData.user?.id ?? null,
          source: 'debrief',
        });
      }

      qc.invalidateQueries({ queryKey: ['interviews', sendOutId] });
      qc.invalidateQueries({ queryKey: ['stage_transitions', 'interview', interview.id] });
      toast.success('Debrief saved');

      if (outcome === 'passed') setAfterSaveAction('offer');
      else if (outcome === 'rejected') setAfterSaveAction('rejected');
      else {
        onSaved?.();
        onClose();
      }
      return true;
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save debrief');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const advanceSendOut = async (toStage: 'offer' | 'rejected') => {
    try {
      const { data: sendOut } = await supabase
        .from('send_outs')
        .select('stage')
        .eq('id', sendOutId)
        .maybeSingle();

      const { error } = await supabase
        .from('send_outs')
        .update({ stage: toStage })
        .eq('id', sendOutId);
      if (error) throw error;

      const { data: userData } = await supabase.auth.getUser();
      await (supabase as any).from('stage_transitions').insert({
        entity_type: 'send_out',
        entity_id: sendOutId,
        from_stage: sendOut?.stage ?? null,
        to_stage: toStage,
        moved_by_type: 'human',
        moved_by: userData.user?.id ?? null,
        source: 'debrief',
      });

      qc.invalidateQueries({ queryKey: ['send_out_board_rows'] });
      qc.invalidateQueries({ queryKey: ['send_out_board_row', sendOutId] });
      qc.invalidateQueries({ queryKey: ['stage_transitions', 'send_out', sendOutId] });
      toast.success(`Send-out moved to ${toStage}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update send-out stage');
    } finally {
      setAfterSaveAction(null);
      onSaved?.();
      onClose();
    }
  };

  const confidencePct = aiConfidence != null
    ? Math.round(aiConfidence > 1 ? aiConfidence : aiConfidence * 100)
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Interview Debrief — Round {interview.round}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Outcome</Label>
                <Select value={outcome} onValueChange={(v) => setOutcome(v as InterviewOutcome)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERVIEW_OUTCOMES.map((o) => (
                      <SelectItem key={o} value={o}>{INTERVIEW_OUTCOME_LABEL[o]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Completed at</Label>
                <Input
                  type="datetime-local"
                  value={completedAt}
                  onChange={(e) => setCompletedAt(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Debrief notes</Label>
              <RichTextEditor
                value={debriefNotes}
                onChange={setDebriefNotes}
                placeholder="What did the interviewer say? Strengths, concerns, next steps…"
                minHeight="140px"
              />
            </div>

            <div>
              <Button
                type="button"
                variant="outline"
                onClick={generateSummary}
                disabled={generatingAi}
                className="border-gold/40 text-gold hover:bg-gold/10"
              >
                {generatingAi ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                )}
                Generate AI Summary
              </Button>
            </div>

            {(aiSummary || aiSentiment || confidencePct != null) && (
              <div className="rounded-md border-2 border-gold/50 bg-gold/5 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-gold" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-gold">AI Summary</span>
                  {aiSentiment && (
                    <Badge
                      variant="outline"
                      className={cn('text-[10px] capitalize', SENTIMENT_STYLES[aiSentiment] || 'bg-muted text-muted-foreground')}
                    >
                      {aiSentiment}
                    </Badge>
                  )}
                  {confidencePct != null && (
                    <Badge variant="outline" className="text-[10px] border-gold/40 text-gold bg-gold/10">
                      {confidencePct}% conf
                    </Badge>
                  )}
                </div>
                {aiSummary && (
                  <div
                    className="text-xs text-foreground/90 whitespace-pre-wrap select-text"
                    // read-only: cannot be edited
                  >
                    {aiSummary}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              type="button"
              onClick={save}
              disabled={saving}
              className="bg-emerald-700 hover:bg-emerald-800 text-white"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              Save Debrief
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={afterSaveAction === 'offer'}
        onOpenChange={(o) => !o && setAfterSaveAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Advance send-out to Offer?</AlertDialogTitle>
            <AlertDialogDescription>
              This interview passed. Would you like to move the send-out into the Offer stage?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setAfterSaveAction(null); onSaved?.(); onClose(); }}>
              No, keep current stage
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => advanceSendOut('offer')}
              className="bg-emerald-700 hover:bg-emerald-800"
            >
              Yes, move to Offer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={afterSaveAction === 'rejected'}
        onOpenChange={(o) => !o && setAfterSaveAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark send-out Rejected?</AlertDialogTitle>
            <AlertDialogDescription>
              The candidate was rejected at this interview. Mark the full send-out as rejected?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setAfterSaveAction(null); onSaved?.(); onClose(); }}>
              No, keep current stage
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => advanceSendOut('rejected')}
              className="bg-destructive hover:bg-destructive/90"
            >
              Yes, mark rejected
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default InterviewDebrief;
