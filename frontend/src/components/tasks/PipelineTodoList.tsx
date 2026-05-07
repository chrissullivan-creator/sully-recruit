import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2, Send, Inbox, FileCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { moveStage } from '@/lib/mutations/move-stage';
import { canonicalConfig, nextStage, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';
import { invalidateTaskScope } from '@/lib/invalidate';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type SendOutRow = {
  id: string;
  stage: string;
  candidate_id: string;
  candidate_job_id: string | null;
  job_id: string;
  recruiter_id: string | null;
  created_at: string;
  candidates: { full_name: string | null } | null;
  jobs: { title: string | null; company_name: string | null } | null;
};

const STAGES: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted'];

const STAGE_ICONS: Record<CanonicalStage, typeof Send> = {
  pitch: Inbox,
  ready_to_send: Send,
  submitted: FileCheck,
  // remaining keys aren't shown in this widget but the type system insists
  interview: Send,
  offer: Send,
  placed: Send,
  withdrawn: Send,
};

/**
 * Pipeline-shaped to-dos surfaced inside the To-Do's page.
 *
 * Why this lives here: a recruiter's daily action list is not just
 * `tasks` rows — open pitches, sendouts, and submissions all need
 * recruiter follow-through. Surfacing them as cards with a "Move to
 * next stage" button means the To-Do's page becomes the single place
 * to see "what do I need to do today" without bouncing into the
 * Send-Outs kanban.
 *
 * Scope:
 *   - send_outs.stage in (pitch, ready_to_send, submitted)
 *   - deleted_at is null
 *   - non-admins see only their own (recruiter_id = userId)
 *
 * Move forward = bump to the next canonical stage via moveStage().
 */
export function PipelineTodoList({
  userId,
  isAdmin,
}: {
  userId: string | null | undefined;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [advancingId, setAdvancingId] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['pipeline-todos', isAdmin ? 'all' : userId],
    queryFn: async () => {
      let q = supabase
        .from('send_outs')
        .select(`
          id, stage, candidate_id, candidate_job_id, job_id, recruiter_id, created_at,
          candidates:candidate_id ( full_name ),
          jobs:job_id ( title, company_name )
        `)
        .is('deleted_at', null)
        .in('stage', ['pitch', 'ready_to_send', 'submitted', 'send_out', 'sendout', 'sent', 'pitched']);

      if (!isAdmin && userId) q = q.eq('recruiter_id', userId);

      const { data, error } = await q.order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as SendOutRow[];
    },
    enabled: !!userId,
  });

  // Bucket rows into the three canonical stages. Pre-canonical raw values
  // (e.g. 'send_out', 'sendout') get folded into 'ready_to_send' by stageToCanonical.
  const buckets: Record<CanonicalStage, SendOutRow[]> = {
    pitch: [],
    ready_to_send: [],
    submitted: [],
    interview: [],
    offer: [],
    placed: [],
    withdrawn: [],
  };
  for (const r of rows) {
    const canon = stageToCanonical(r.stage);
    if (canon && STAGES.includes(canon)) buckets[canon].push(r);
  }

  const totalOpen = STAGES.reduce((n, s) => n + buckets[s].length, 0);
  if (isLoading || totalOpen === 0) return null;

  const handleAdvance = async (row: SendOutRow) => {
    const canon = stageToCanonical(row.stage);
    if (!canon) return;
    const next = nextStage(canon);
    if (!next) return;

    setAdvancingId(row.id);
    try {
      const result = await moveStage({
        sendOutId: row.id,
        candidateJobId: row.candidate_job_id,
        fromStage: canon,
        toStage: next,
        triggerSource: 'todos',
        entityId: row.candidate_id,
      });
      if (!result.ok) throw new Error(result.error || 'Move failed');
      toast.success(`Moved to ${canonicalConfig(next).label}`);
      queryClient.invalidateQueries({ queryKey: ['pipeline-todos'] });
      // Send-Outs board / pipeline counts read from a few different keys; invalidate them too.
      queryClient.invalidateQueries({ queryKey: ['send_outs'] });
      queryClient.invalidateQueries({ queryKey: ['send-outs'] });
      invalidateTaskScope(queryClient);
    } catch (err: any) {
      toast.error(err?.message || 'Move failed');
    } finally {
      setAdvancingId(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">Pipeline to-do's</h2>
        <span className="text-[11px] text-muted-foreground">
          {totalOpen} open · pitch → submission
        </span>
      </div>

      {STAGES.map((stage) => {
        const items = buckets[stage];
        if (items.length === 0) return null;
        const cfg = canonicalConfig(stage);
        const Icon = STAGE_ICONS[stage];
        const next = nextStage(stage);
        return (
          <section key={stage} className="space-y-1.5">
            <div className="flex items-center gap-2 px-1">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">{cfg.label}</span>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {items.length}
              </Badge>
            </div>
            <ul className="space-y-1.5">
              {items.map((row) => {
                const candidateName = row.candidates?.full_name || 'Unknown candidate';
                const jobTitle = row.jobs?.title || 'Untitled job';
                const company = row.jobs?.company_name;
                const advancing = advancingId === row.id;
                return (
                  <li
                    key={row.id}
                    className={cn(
                      'flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2 hover:bg-muted/30 transition-colors',
                    )}
                  >
                    <div className={cn('h-2 w-2 rounded-full shrink-0', cfg.dotColor)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground truncate">
                        <Link
                          to={`/candidates/${row.candidate_id}`}
                          className="font-medium hover:underline"
                        >
                          {candidateName}
                        </Link>
                        <span className="text-muted-foreground"> → </span>
                        <Link to={`/jobs/${row.job_id}`} className="hover:underline">
                          {jobTitle}
                        </Link>
                        {company && (
                          <span className="text-xs text-muted-foreground"> · {company}</span>
                        )}
                      </div>
                    </div>
                    {next && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleAdvance(row)}
                        disabled={advancing}
                        className="shrink-0 h-7 text-xs"
                      >
                        {advancing ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <ArrowRight className="h-3 w-3 mr-1" />
                        )}
                        Move to {canonicalConfig(next).shortLabel}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <div className="border-t border-border/40 pt-2" />
    </div>
  );
}
