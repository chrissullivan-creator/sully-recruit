import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useSequences } from '@/hooks/useSupabaseData';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Linkedin, Users, Loader2 } from 'lucide-react';

interface EnrollInSequenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidateIds: string[];
  candidateNames?: string[];
}

export const EnrollInSequenceDialog = ({ open, onOpenChange, candidateIds, candidateNames = [] }: EnrollInSequenceDialogProps) => {
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>('');
  const [enrolling, setEnrolling] = useState(false);
  const { data: sequences = [], isLoading } = useSequences();
  const queryClient = useQueryClient();

  const activeSequences = sequences.filter((s) => s.status === 'active' || s.status === 'draft');

  const selectedSequence = sequences.find((s) => s.id === selectedSequenceId);
  const steps = (selectedSequence?.sequence_steps as any[]) ?? [];

  const channelIcon = (channel: string) => {
    if (channel === 'linkedin') return <Linkedin className="h-3.5 w-3.5" />;
    if (channel === 'email') return <Mail className="h-3.5 w-3.5" />;
    return <Mail className="h-3.5 w-3.5" />;
  };

  const handleEnroll = async () => {
    if (!selectedSequenceId || candidateIds.length === 0) return;
    setEnrolling(true);

    try {
      const enrollments = candidateIds.map((candidateId) => ({
        sequence_id: selectedSequenceId,
        candidate_id: candidateId,
        status: 'active',
        current_step_order: 1,
      }));

      const { error } = await supabase.from('sequence_enrollments').insert(enrollments);
      if (error) throw error;

      toast.success(`Enrolled ${candidateIds.length} candidate${candidateIds.length > 1 ? 's' : ''} in sequence`);
      queryClient.invalidateQueries({ queryKey: ['sequences'] });
      queryClient.invalidateQueries({ queryKey: ['sequence_enrollments'] });
      onOpenChange(false);
      setSelectedSequenceId('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to enroll candidates');
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enroll in Sequence</DialogTitle>
          <DialogDescription>
            {candidateIds.length === 1 && candidateNames[0]
              ? `Enroll ${candidateNames[0]} in an outreach sequence.`
              : `Enroll ${candidateIds.length} candidates in an outreach sequence.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {candidateIds.length > 1 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>{candidateIds.length} candidates selected</span>
            </div>
          )}

          <div className="space-y-2">
            <Label>Select Sequence</Label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading sequences...</p>
            ) : activeSequences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active sequences available. Create one in Campaigns first.</p>
            ) : (
              <Select value={selectedSequenceId} onValueChange={setSelectedSequenceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a sequence..." />
                </SelectTrigger>
                <SelectContent>
                  {activeSequences.map((seq) => (
                    <SelectItem key={seq.id} value={seq.id}>
                      <span className="flex items-center gap-2">
                        {channelIcon(seq.channel)}
                        {seq.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedSequence && (
            <div className="rounded-lg border border-border bg-secondary/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{selectedSequence.name}</span>
                <Badge variant="secondary" className="text-xs capitalize">{selectedSequence.channel}</Badge>
              </div>
              {selectedSequence.description && (
                <p className="text-xs text-muted-foreground">{selectedSequence.description}</p>
              )}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {steps.length} Steps
                </span>
                {steps.sort((a: any, b: any) => a.step_order - b.step_order).map((step: any) => (
                  <div key={step.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px]">
                      {step.step_order}
                    </span>
                    <span className="capitalize">{step.channel ?? selectedSequence.channel}</span>
                    {step.delay_days > 0 && (
                      <span className="text-muted-foreground/60">• wait {step.delay_days}d</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="gold"
            onClick={handleEnroll}
            disabled={!selectedSequenceId || enrolling}
          >
            {enrolling && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Enroll{candidateIds.length > 1 ? ` (${candidateIds.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
