import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RichTextEditor } from '@/components/shared/RichTextEditor';
import { EntityAvatar } from '@/components/shared/EntityAvatar';
import { StageTransitionLog } from '@/components/shared/StageTransitionLog';
import { InterviewList } from '@/components/sendouts/InterviewList';
import { PlacementForm } from '@/components/sendouts/PlacementForm';
import {
  SEND_OUT_STAGES, STAGE_LABEL, STAGE_BADGE, type SendOutStage,
} from '@/components/sendouts/sendOutStages';
import { useSendOutBoardRow } from '@/components/sendouts/useSendOutData';
import { useNotes } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Briefcase, Building2, ExternalLink, Link as LinkIcon, Loader2, Save, User, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SendOutDrawerProps {
  sendOutId: string | null;
  open: boolean;
  onClose: () => void;
}

export function SendOutDrawer({ sendOutId, open, onClose }: SendOutDrawerProps) {
  const { data: row, isLoading } = useSendOutBoardRow(sendOutId || undefined);
  const { data: notes = [] } = useNotes(sendOutId || undefined, 'send_out');
  const qc = useQueryClient();

  const [stage, setStage] = useState<SendOutStage>('send_out');
  const [submittedAt, setSubmittedAt] = useState<string>('');
  const [submittalNotes, setSubmittalNotes] = useState<string>('');
  const [resumeLink, setResumeLink] = useState<string>('');
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (!row) return;
    setStage((row.stage as SendOutStage) ?? 'send_out');
    setSubmittedAt(row.sent_to_client_at ? row.sent_to_client_at.slice(0, 16) : '');
    setSubmittalNotes(row.submittal_notes ?? '');
    setResumeLink(row.resume_link ?? '');
    setRejectionReason(row.rejection_reason ?? '');
  }, [row]);

  const save = async () => {
    if (!sendOutId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('send_outs')
        .update({
          stage,
          sent_to_client_at: submittedAt ? new Date(submittedAt).toISOString() : null,
          submittal_notes: submittalNotes || null,
          resume_link: resumeLink || null,
          rejection_reason: rejectionReason || null,
        } as any)
        .eq('id', sendOutId);
      if (error) throw error;

      if (row && row.stage !== stage) {
        const { data: userData } = await supabase.auth.getUser();
        await (supabase as any).from('stage_transitions').insert({
          entity_type: 'send_out',
          entity_id: sendOutId,
          from_stage: row.stage,
          to_stage: stage,
          moved_by_type: 'human',
          moved_by: userData.user?.id ?? null,
          source: 'drawer',
        });
      }

      qc.invalidateQueries({ queryKey: ['send_out_board_rows'] });
      qc.invalidateQueries({ queryKey: ['send_out_board_row', sendOutId] });
      qc.invalidateQueries({ queryKey: ['stage_transitions', 'send_out', sendOutId] });
      toast.success('Saved');
    } catch (err: any) {
      toast.error(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addNote = async () => {
    if (!sendOutId || !newNote.trim()) return;
    setSavingNote(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from('notes').insert({
        entity_type: 'send_out',
        entity_id: sendOutId,
        note: newNote.trim(),
        created_by: userData.user?.id ?? null,
      });
      if (error) throw error;
      setNewNote('');
      qc.invalidateQueries({ queryKey: ['notes', 'send_out', sendOutId] });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to add note');
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[600px] p-0 flex flex-col"
      >
        {isLoading || !row ? (
          <div className="flex items-center justify-center flex-1 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <>
            <SheetHeader className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-start gap-3">
                <EntityAvatar
                  avatarUrl={row.candidate_avatar_url}
                  email={row.candidate_email}
                  name={row.candidate_name}
                  size="lg"
                />
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-lg truncate">{row.candidate_name || 'Unknown candidate'}</SheetTitle>
                  <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1 truncate">
                    <Briefcase className="h-3 w-3 shrink-0" />
                    <span className="truncate">{row.job_title || '—'}</span>
                  </div>
                  {row.company_name && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                      <Building2 className="h-3 w-3 shrink-0" />
                      <span className="truncate">{row.company_name}</span>
                    </div>
                  )}
                  <Badge
                    variant="outline"
                    className={cn('mt-2 capitalize', STAGE_BADGE[stage])}
                  >
                    {STAGE_LABEL[stage]}
                  </Badge>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px]">
                {/* Left column — details + tabs */}
                <div className="p-6 space-y-5">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <User className="h-3.5 w-3.5" />
                      Candidate
                    </div>
                    <div className="truncate">{row.candidate_name || '—'}</div>

                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Briefcase className="h-3.5 w-3.5" />
                      Job
                    </div>
                    <div className="truncate">{row.job_title || '—'}</div>

                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5" />
                      Client contact
                    </div>
                    <div className="truncate">{row.contact_name || '—'}</div>

                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <UserCheck className="h-3.5 w-3.5" />
                      Recruiter
                    </div>
                    <div className="truncate">{row.recruiter_name || '—'}</div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Stage</Label>
                    <Select value={stage} onValueChange={(v) => setStage(v as SendOutStage)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SEND_OUT_STAGES.map((s) => (
                          <SelectItem key={s} value={s}>{STAGE_LABEL[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Submitted at</Label>
                    <Input
                      type="datetime-local"
                      value={submittedAt}
                      onChange={(e) => setSubmittedAt(e.target.value)}
                      className="h-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Resume link</Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <LinkIcon className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={resumeLink}
                          onChange={(e) => setResumeLink(e.target.value)}
                          placeholder="https://…"
                          className="pl-8 h-9"
                        />
                      </div>
                      {resumeLink && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => window.open(resumeLink, '_blank', 'noopener')}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Submittal notes</Label>
                    <RichTextEditor
                      value={submittalNotes}
                      onChange={setSubmittalNotes}
                      placeholder="Why is this candidate a fit? Highlights, concerns, asks…"
                      minHeight="120px"
                    />
                  </div>

                  {(stage === 'rejected' || row.stage === 'rejected') && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Rejection reason</Label>
                      <Textarea
                        value={rejectionReason}
                        onChange={(e) => setRejectionReason(e.target.value)}
                        rows={3}
                      />
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button
                      onClick={save}
                      disabled={saving}
                      className="bg-emerald-700 hover:bg-emerald-800 text-white"
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                      Save
                    </Button>
                  </div>

                  {/* Tabs */}
                  <Tabs defaultValue="interviews" className="mt-4">
                    <TabsList>
                      <TabsTrigger value="interviews">Interviews</TabsTrigger>
                      <TabsTrigger value="notes">Notes</TabsTrigger>
                      {stage === 'placed' && <TabsTrigger value="placement">Placement</TabsTrigger>}
                    </TabsList>

                    <TabsContent value="interviews" className="mt-4">
                      <InterviewList sendOutId={row.id} />
                    </TabsContent>

                    <TabsContent value="notes" className="mt-4 space-y-3">
                      <div className="space-y-2">
                        <Textarea
                          value={newNote}
                          onChange={(e) => setNewNote(e.target.value)}
                          placeholder="Add a note…"
                          rows={3}
                        />
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            size="sm"
                            disabled={!newNote.trim() || savingNote}
                            onClick={addNote}
                          >
                            {savingNote ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                            Add note
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {notes.length === 0 && (
                          <div className="text-xs text-muted-foreground italic">No notes yet.</div>
                        )}
                        {notes.map((n: any) => (
                          <div key={n.id} className="rounded-md border border-border bg-muted/30 p-3">
                            <div className="text-[11px] text-muted-foreground">
                              {format(new Date(n.created_at), 'MMM d, yyyy · h:mm a')}
                            </div>
                            <div className="mt-1 text-xs whitespace-pre-wrap">{n.note}</div>
                          </div>
                        ))}
                      </div>
                    </TabsContent>

                    {stage === 'placed' && (
                      <TabsContent value="placement" className="mt-4">
                        <PlacementForm sendOutId={row.id} />
                      </TabsContent>
                    )}
                  </Tabs>
                </div>

                {/* Right column — stage history */}
                <div className="border-t lg:border-t-0 lg:border-l border-border p-4 bg-muted/20">
                  <StageTransitionLog entityType="send_out" entityId={row.id} />
                </div>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default SendOutDrawer;
