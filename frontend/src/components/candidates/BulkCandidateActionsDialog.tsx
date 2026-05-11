import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/shared/SearchableSelect';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useJobs, useSequences } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { TablesInsert, TablesUpdate } from '@/integrations/supabase/types';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, Loader2, Briefcase, Play, Wand2 } from 'lucide-react';
import { authHeaders } from '@/lib/api-auth';
import { ensureInterviewArtifacts, normalizeInterviewStage } from '@/lib/interviewWorkflow';
import { invalidateSendOutScope, invalidateTaskScope } from '@/lib/invalidate';

interface BulkCandidateActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateIds: string[];
  candidateNames?: string[];
}

const stageBadgeColor: Record<string, string> = {
  lead: 'bg-slate-500/15 text-slate-600',
  back_of_resume: 'bg-muted text-muted-foreground',
  reached_out: 'bg-blue-500/15 text-blue-600',
  pitch: 'bg-indigo-500/15 text-indigo-600',
  sent: 'bg-purple-500/15 text-purple-600',
  interview: 'bg-amber-500/15 text-amber-600',
  offer: 'bg-emerald-500/15 text-emerald-600',
  placed: 'bg-green-600/15 text-green-700',
  rejected: 'bg-destructive/15 text-destructive',
};

const sendOutStages = [
  { value: 'lead', label: 'Lead' },
  { value: 'back_of_resume', label: 'Back of Resume' },
  { value: 'reached_out', label: 'Reached Out' },
  { value: 'pitch', label: 'Pitch' },
  { value: 'ready_to_send', label: 'Send Out' },
  { value: 'submitted', label: 'Submission' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'placed', label: 'Placement' },
  { value: 'rejected', label: 'Rejected' },
];

const rejectedByOptions = [
  { value: 'recruiter', label: 'By Recruiter' },
  { value: 'client', label: 'By Client' },
  { value: 'sales_person', label: 'By Sales Person' },
  { value: 'candidate', label: 'By Candidate' },
];

type SendOutInsert = TablesInsert<'send_outs'>;
// `candidates` is now a view in regenerated types; TablesUpdate only accepts
// base tables. Use the underlying `people` shape; runtime queries against
// the candidates view still take the same column names.
type CandidateUpdate = TablesUpdate<'people'> & {
  job_id?: string | null;
  job_status?: string | null;
};

const isSequenceSelectable = (sequence: any) => {
  const status = String(sequence?.status || '').toLowerCase();
  return status === 'active' || status === 'draft';
};

export const BulkCandidateActionsDialog = ({
  open,
  onOpenChange,
  candidateIds,
  candidateNames = [],
}: BulkCandidateActionsDialogProps) => {
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [selectedStage, setSelectedStage] = useState<string>('lead');
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>('');
  const [enrollInSequence, setEnrollInSequence] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [rejectedBy, setRejectedBy] = useState<string>('');
  const [rejectionDetails, setRejectionDetails] = useState<string>('');
  const [enriching, setEnriching] = useState(false);

  const { data: jobs = [] } = useJobs();
  const { data: sequences = [] } = useSequences();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) {
      setSelectedJobId('');
      setSelectedStage('lead');
      setSelectedSequenceId('');
      setEnrollInSequence(false);
      setRejectedBy('');
      setRejectionDetails('');
    }
  }, [open]);

  const activeSequences = sequences.filter(isSequenceSelectable);
  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  const selectedCountLabel = `${candidateIds.length} candidate${candidateIds.length > 1 ? 's' : ''}`;
  const selectedNamesPreview = candidateNames.filter(Boolean).slice(0, 3).join(', ');

  const handleSubmit = async () => {
    if (!selectedJobId || candidateIds.length === 0) return;
    if (selectedStage === 'rejected' && !rejectedBy) {
      toast.error('Please select who rejected the candidate');
      return;
    }

    setProcessing(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;

      const normalizedStage = normalizeInterviewStage(selectedStage);
      const sendOuts: (SendOutInsert & { rejected_by?: string; rejection_reason?: string; feedback?: string })[] = candidateIds.map((candidateId) => {
        const record: any = {
          job_id: selectedJobId,
          candidate_id: candidateId,
          stage: normalizedStage,
          recruiter_id: userId,
        };
        if (normalizedStage === 'rejected') {
          record.rejected_by = rejectedBy;
          record.rejection_reason = rejectionDetails || null;
        }
        if (normalizedStage === 'sent') record.sent_to_client_at = new Date().toISOString();
        if (normalizedStage === 'interviewing') record.interview_at = new Date().toISOString();
        if (normalizedStage === 'offer') record.offer_at = new Date().toISOString();
        if (normalizedStage === 'placed') record.placed_at = new Date().toISOString();
        return record;
      });

      const { data: createdSendOuts, error: sendOutError } = await supabase
        .from('send_outs')
        .insert(sendOuts as any)
        .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at');

      if (sendOutError) throw sendOutError;

      if (normalizedStage === 'interviewing') {
        await Promise.all(
          (createdSendOuts || []).map((record: any) =>
            ensureInterviewArtifacts({
              sendOutId: record.id,
              candidateId: record.candidate_id,
              contactId: record.contact_id,
              jobId: record.job_id,
              recruiterId: record.recruiter_id,
              stage: normalizedStage,
              interviewAt: record.interview_at,
            }),
          ),
        );
      }

      if (enrollInSequence && selectedSequenceId) {
        const enrollments = candidateIds.map((candidateId) => ({
          sequence_id: selectedSequenceId,
          candidate_id: candidateId,
          status: 'active',
          enrolled_by: userId,
        }));

        const { error: enrollmentError } = await supabase
          .from('sequence_enrollments')
          .insert(enrollments);

        if (enrollmentError) throw enrollmentError;
      }

      // Update job_id and job_status on candidates (fix: was using tagged_job_id)
      const { error: updateError } = await supabase
        .from('people')
        .update({ job_id: selectedJobId, job_status: normalizedStage } as CandidateUpdate)
        .in('id', candidateIds);

      if (updateError) throw updateError;

      invalidateSendOutScope(queryClient);
      invalidateTaskScope(queryClient);
      if (enrollInSequence) {
        queryClient.invalidateQueries({ queryKey: ['sequences'] });
        queryClient.invalidateQueries({ queryKey: ['sequence_enrollments'] });
      }

      const actions = [`added to ${selectedJob?.title || 'job'}`];
      if (enrollInSequence && selectedSequenceId) {
        const sequence = sequences.find((s) => s.id === selectedSequenceId);
        actions.push(`enrolled in "${sequence?.name || 'sequence'}"`);
      }

      toast.success(`Successfully ${actions.join(' and ')} for ${selectedCountLabel}`);
      onOpenChange(false);
    } catch (err: any) {
      console.error('Bulk action error:', err);
      toast.error(err.message || 'Failed to complete bulk actions');
    } finally {
      setProcessing(false);
    }
  };

  const canSubmit = selectedJobId && candidateIds.length > 0
    && (!enrollInSequence || selectedSequenceId)
    && (selectedStage !== 'rejected' || rejectedBy);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Bulk Candidate Actions
          </DialogTitle>
          <DialogDescription>
            Add {selectedCountLabel} to a job and optionally enroll them in a sequence.
            {selectedNamesPreview ? ` Selected: ${selectedNamesPreview}${candidateIds.length > 3 ? '...' : ''}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            <span>{selectedCountLabel} selected</span>
          </div>

          {/* Bytemine enrichment — stand-alone action (work email + contact info
              via LinkedIn URL lookup). Doesn't gate the rest of the dialog. */}
          <div className="rounded-md border border-card-border bg-secondary/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Enrich via Bytemine</p>
                <p className="text-xs text-muted-foreground">
                  Pull verified work email, phone, title, company from LinkedIn URLs.
                </p>
              </div>
              <Button
                size="sm" variant="outline"
                disabled={enriching || candidateIds.length === 0 || candidateIds.length > 100}
                onClick={async () => {
                  setEnriching(true);
                  try {
                    // Bytemine endpoint caps at 100/request — chunk if larger.
                    const chunks: string[][] = [];
                    for (let i = 0; i < candidateIds.length; i += 100) {
                      chunks.push(candidateIds.slice(i, i + 100));
                    }
                    let okTotal = 0, failTotal = 0, noLinkedinTotal = 0;
                    for (const chunk of chunks) {
                      const res = await fetch('/api/people/bytemine-enrich', {
                        method: 'POST',
                        headers: await authHeaders(),
                        body: JSON.stringify({ peopleIds: chunk }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || 'Enrich failed');
                      okTotal += data.counts?.ok ?? 0;
                      failTotal += data.counts?.failed ?? 0;
                      noLinkedinTotal += data.counts?.no_linkedin ?? 0;
                    }
                    toast.success(
                      `Enriched: ${okTotal} ok, ${failTotal} failed` +
                      (noLinkedinTotal > 0 ? ` (${noLinkedinTotal} had no LinkedIn URL)` : ''),
                    );
                    queryClient.invalidateQueries({ queryKey: ['candidates'] });
                  } catch (e: any) {
                    toast.error(e.message || 'Enrich failed');
                  } finally {
                    setEnriching(false);
                  }
                }}
              >
                {enriching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1.5" />}
                Enrich {candidateIds.length > 0 ? `(${candidateIds.length})` : ''}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Select Job</Label>
            <SearchableSelect
              options={(jobs as any[]).map((job: any) => ({
                value: job.id,
                label: job.title,
                sublabel: `at ${job.company_name ?? (job.companies as any)?.name ?? 'Unknown company'}`,
              }))}
              value={selectedJobId}
              onChange={setSelectedJobId}
              placeholder="Choose a job..."
              searchPlaceholder="Search jobs..."
              emptyText="No job found."
            />
          </div>

          <div className="space-y-2">
            <Label>Set Status</Label>
            <Select value={selectedStage} onValueChange={(val) => { setSelectedStage(val); if (val !== 'rejected') { setRejectedBy(''); setRejectionDetails(''); } }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sendOutStages.map((stage) => (
                  <SelectItem key={stage.value} value={stage.value}>
                    <Badge className={stageBadgeColor[stage.value] || 'bg-muted text-muted-foreground'}>
                      {stage.label}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Rejection details sub-form */}
          {selectedStage === 'rejected' && (
            <div className="space-y-3 rounded-md border border-red-500/30 bg-red-500/5 p-4">
              <h5 className="text-xs font-semibold text-red-400">Rejection Details</h5>
              <div className="space-y-1">
                <Label className="text-xs">Rejected By *</Label>
                <Select value={rejectedBy} onValueChange={setRejectedBy}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Who rejected?" />
                  </SelectTrigger>
                  <SelectContent>
                    {rejectedByOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Details</Label>
                <textarea
                  value={rejectionDetails}
                  onChange={(e) => setRejectionDetails(e.target.value)}
                  className="w-full rounded-md border border-input bg-background text-foreground p-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
                  rows={2}
                  placeholder="Reason for rejection..."
                />
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="enroll-sequence"
                checked={enrollInSequence}
                onCheckedChange={(checked) => setEnrollInSequence(!!checked)}
              />
              <Label htmlFor="enroll-sequence" className="text-sm">
                Also enroll in a sequence
              </Label>
            </div>

            {enrollInSequence && (
              <div className="ml-6 space-y-2">
                <Label>Select Sequence</Label>
                <Select value={selectedSequenceId} onValueChange={setSelectedSequenceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a sequence..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeSequences.map((seq) => (
                      <SelectItem key={seq.id} value={seq.id}>
                        <div className="flex items-center gap-2">
                          <Play className="h-3.5 w-3.5" />
                          {seq.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || processing}
            className="min-w-[120px]"
          >
            {processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {processing ? 'Processing...' : 'Apply Actions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
