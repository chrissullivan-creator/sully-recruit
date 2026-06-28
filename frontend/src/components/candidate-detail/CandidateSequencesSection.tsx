import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Play, Plus, GitBranch } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/shared/SectionCard';
import { EmptyState } from '@/components/shared/EmptyState';
import { SentimentChip } from '@/components/shared/SentimentChip';

interface CandidateSequencesSectionProps {
  candidateId: string;
  /** Opens the existing EnrollInSequenceDialog. */
  onAddToSequence: () => void;
}

const STATUS_PILL: Record<string, string> = {
  active: 'bg-accent/10 text-accent',
  completed: 'bg-primary/10 text-primary',
  stopped: 'bg-destructive/10 text-destructive',
  paused: 'bg-muted text-muted-foreground',
};

/**
 * Sequences section on the Communication tab. Lists this person's
 * sequence_enrollments (status, reply sentiment, step results) and offers
 * "Add to sequence" (existing enroll dialog) + "Create from this person"
 * (sequence builder seeded with this person). Data is read here; the actual
 * enroll/create flows stay in their existing components.
 */
export function CandidateSequencesSection({ candidateId, onAddToSequence }: CandidateSequencesSectionProps) {
  const navigate = useNavigate();

  const { data: enrollments = [], isLoading } = useQuery({
    queryKey: ['candidate_sequence_enrollments', candidateId],
    enabled: !!candidateId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sequence_enrollments')
        .select('id, status, enrolled_at, reply_sentiment, reply_sentiment_note, stop_reason, sequences(id, name)')
        .eq('candidate_id', candidateId)
        .order('enrolled_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  return (
    <SectionCard
      title="Sequences"
      icon={<GitBranch className="h-4 w-4" />}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => navigate(`/sequences/new?fromPerson=${candidateId}`)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Create from this person
          </Button>
          <Button variant="gold" size="sm" onClick={onAddToSequence}>
            <Play className="h-3.5 w-3.5 mr-1" /> Add to sequence
          </Button>
        </>
      }
    >
      {isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Loading…</p>
      ) : enrollments.length === 0 ? (
        <EmptyState icon={GitBranch} title="Not enrolled in any sequence" className="py-8" />
      ) : (
        <ul className="space-y-2">
          {enrollments.map((e: any) => (
            <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl border border-card-border bg-card p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {e.sequences?.name ?? 'Sequence'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Enrolled {e.enrolled_at ? format(new Date(e.enrolled_at), 'MMM d, yyyy') : '—'}
                  {e.stop_reason ? ` · ${e.stop_reason}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {e.reply_sentiment && <SentimentChip sentiment={e.reply_sentiment} note={e.reply_sentiment_note} />}
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_PILL[e.status] ?? 'bg-muted text-muted-foreground'}`}>
                  {e.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
