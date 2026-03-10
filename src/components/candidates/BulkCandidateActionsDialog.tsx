import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useJobs, useSequences, useCandidates } from '@/hooks/useData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, Loader2, Briefcase, Play } from 'lucide-react';

interface BulkCandidateActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateIds: string[];
  candidateNames?: string[];
}

const stageBadgeColor: Record<string, string> = {
  new: 'bg-muted text-muted-foreground',
  submitted: 'bg-blue-500/15 text-blue-600',
  interview: 'bg-amber-500/15 text-amber-600',
  offer: 'bg-emerald-500/15 text-emerald-600',
  placed: 'bg-green-600/15 text-green-700',
  rejected: 'bg-destructive/15 text-destructive',
};

const candidateStages = [
  { value: 'send_out', label: 'Send Out' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'interview', label: 'Interview' },
  { value: 'first_round', label: 'First Round' },
  { value: 'second_round', label: 'Second Round' },
  { value: 'third_plus_round', label: 'Third+ Round' },
  { value: 'offer', label: 'Offer' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'counter_offer', label: 'Counter Offer' },
  { value: 'disqualified', label: 'Disqualified' },
];

export const BulkCandidateActionsDialog = ({
  open,
  onOpenChange,
  candidateIds,
  candidateNames = []
}: BulkCandidateActionsDialogProps) => {
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [selectedStage, setSelectedStage] = useState<string>('send_out');
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>('');
  const [enrollInSequence, setEnrollInSequence] = useState(false);
  const [processing, setProcessing] = useState(false);

  const { data: jobs = [] } = useJobs();
  const { data: sequences = [] } = useSequences();
  const { data: candidates = [] } = useCandidates();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) {
      setSelectedJobId('');
      setSelectedStage('send_out');
      setSelectedSequenceId('');
      setEnrollInSequence(false);
    }
  }, [open]);

  const activeSequences = sequences.filter((s) => s.status === 'active' || s.status === 'draft');
  const selectedJob = jobs.find((j) => j.id === selectedJobId);

  const handleSubmit = async () => {
    if (!selectedJobId || candidateIds.length === 0) return;

    setProcessing(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;

      // 1. Add candidates to send_out_board
      const sendOuts = candidateIds.map((candidateId) => ({
        job_id: selectedJobId,
        candidate_id: candidateId,
        stage: selectedStage,
        created_by: userId,
      }));

      const { error: sendOutError } = await supabase
        .from('send_out_board')
        .insert(sendOuts);

      if (sendOutError) throw sendOutError;

      // 2. Optionally enroll in sequence
      if (enrollInSequence && selectedSequenceId) {
        const enrollments = candidateIds.map((candidateId) => ({
          sequence_id: selectedSequenceId,
          candidate_id: candidateId,
          status: 'active',
          current_step_order: 1,
          enrolled_by: userId,
        }));

        const { error: enrollmentError } = await supabase
          .from('sequence_enrollments')
          .insert(enrollments);

        if (enrollmentError) throw enrollmentError;
      }

      // 3. Update candidate tagged_job_id
      const { error: updateError } = await supabase
        .from('candidates')
        .update({ tagged_job_id: selectedJobId })
        .in('id', candidateIds);

      if (updateError) throw updateError;

      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['candidates'] });
      queryClient.invalidateQueries({ queryKey: ['send_out_board'] });
      queryClient.invalidateQueries({ queryKey: ['send_outs_job', selectedJobId] });
      if (enrollInSequence) {
        queryClient.invalidateQueries({ queryKey: ['sequences'] });
        queryClient.invalidateQueries({ queryKey: ['sequence_enrollments'] });
      }

      const actions = [`added to ${selectedJob?.title || 'job'}`];
      if (enrollInSequence && selectedSequenceId) {
        const sequence = sequences.find(s => s.id === selectedSequenceId);
        actions.push(`enrolled in "${sequence?.name || 'sequence'}"`);
      }

      toast.success(`Successfully ${actions.join(' and ')} for ${candidateIds.length} candidate${candidateIds.length > 1 ? 's' : ''}`);
      onOpenChange(false);
    } catch (err: any) {
      console.error('Bulk action error:', err);
      toast.error(err.message || 'Failed to complete bulk actions');
    } finally {
      setProcessing(false);
    }
  };

  const canSubmit = selectedJobId && candidateIds.length > 0 && (!enrollInSequence || selectedSequenceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Bulk Candidate Actions
          </DialogTitle>
          <DialogDescription>
            Add {candidateIds.length} selected candidate{candidateIds.length > 1 ? 's' : ''} to a job and optionally enroll them in a sequence.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Selected Candidates Summary */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            <span>{candidateIds.length} candidate{candidateIds.length > 1 ? 's' : ''} selected</span>
          </div>

          {/* Job Selection */}
          <div className="space-y-2">
            <Label>Select Job</Label>
            <Select value={selectedJobId} onValueChange={setSelectedJobId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a job..." />
              </SelectTrigger>
              <SelectContent>
                {jobs.map((job) => (
                  <SelectItem key={job.id} value={job.id}>
                    <div className="flex items-center gap-2">
                      <Briefcase className="h-3.5 w-3.5" />
                      <span>{job.title}</span>
                      <span className="text-xs text-muted-foreground">at {job.company}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stage Selection */}
          <div className="space-y-2">
            <Label>Set Status</Label>
            <Select value={selectedStage} onValueChange={setSelectedStage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidateStages.map((stage) => (
                  <SelectItem key={stage.value} value={stage.value}>
                    <Badge className={stageBadgeColor[stage.value] || 'bg-muted text-muted-foreground'}>
                      {stage.label}
                    </Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Sequence Enrollment Option */}
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
              <div className="space-y-2 ml-6">
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
            {processing && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {processing ? 'Processing...' : 'Apply Actions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};