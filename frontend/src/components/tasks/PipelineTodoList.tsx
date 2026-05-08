import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2, Send, Inbox, FileCheck, MoreHorizontal, XCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

// Per-stage staleness threshold. After this many days in stage, the row
// gets a "Stuck" badge so it visually rises to the top of attention.
// Tuned to recruiter rhythm — pitches are quick, submissions take longest.
const STALE_DAYS: Record<CanonicalStage, number> = {
  pitch: 3,
  ready_to_send: 2,
  submitted: 7,
  interview: 14,
  offer: 14,
  placed: Infinity,
  withdrawn: Infinity,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function ageInDays(iso: string): number {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY_MS);
}

function ageLabel(days: number): string {
  if (days < 1) return 'today';
  if (days < 2) return '1d';
  return `${Math.floor(days)}d`;
}

/**
 * Pipeline-shaped to-dos surfaced inside the To-Do's page.
 *
 * Why this lives here: a recruiter's daily action list is not just
 * `tasks` rows — open pitches, sendouts, and submissions all need
 * recruiter follow-through. Surfacing them as cards with stage-aware
 * staleness flags + a Move/Withdraw menu means the To-Do's page becomes
 * the single place to see "what do I need to do today" without
 * bouncing into the Send-Outs kanban.
 *
 * Scope:
 *   - send_outs.stage in (pitch, ready_to_send, submitted)
 *   - deleted_at is null
 *   - non-admins see only their own (recruiter_id = userId)
 *
 * Within each stage bucket, stuck rows (over the per-stage staleness
 * threshold) sort to the top, then by oldest.
 */
export function PipelineTodoList({
  userId,
  isAdmin,
}: {
  userId: string | null | undefined;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

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

  // Stuck rows float to the top of each bucket so the user's eye lands
  // on what's been waiting the longest.
  for (const stage of STAGES) {
    const threshold = STALE_DAYS[stage];
    buckets[stage].sort((a, b) => {
      const aStuck = ageInDays(a.created_at) >= threshold;
      const bStuck = ageInDays(b.created_at) >= threshold;
      if (aStuck !== bStuck) return aStuck ? -1 : 1;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }

  const totalOpen = STAGES.reduce((n, s) => n + buckets[s].length, 0);
  const totalStuck = STAGES.reduce((n, s) => {
    const t = STALE_DAYS[s];
    return n + buckets[s].filter((r) => ageInDays(r.created_at) >= t).length;
  }, 0);
  if (isLoading || totalOpen === 0) return null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pipeline-todos'] });
    // Send-Outs board / pipeline counts read from a few different keys; invalidate them too.
    queryClient.invalidateQueries({ queryKey: ['send_outs'] });
    queryClient.invalidateQueries({ queryKey: ['send-outs'] });
    invalidateTaskScope(queryClient);
  };

  const handleAdvance = async (row: SendOutRow) => {
    const canon = stageToCanonical(row.stage);
    if (!canon) return;
    const next = nextStage(canon);
    if (!next) return;
    setBusyId(row.id);
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
      invalidate();
    } catch (err: any) {
      toast.error(err?.message || 'Move failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleWithdraw = async (row: SendOutRow) => {
    const canon = stageToCanonical(row.stage);
    if (!canon) return;
    setBusyId(row.id);
    try {
      const result = await moveStage({
        sendOutId: row.id,
        candidateJobId: row.candidate_job_id,
        fromStage: canon,
        toStage: 'withdrawn',
        triggerSource: 'todos',
        entityId: row.candidate_id,
      });
      if (!result.ok) throw new Error(result.error || 'Withdraw failed');
      toast.success('Marked withdrawn');
      invalidate();
    } catch (err: any) {
      toast.error(err?.message || 'Withdraw failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">Pipeline to-do's</h2>
        <span className="text-[11px] text-muted-foreground">
          {totalOpen} open · pitch → submission
          {totalStuck > 0 && (
            <span className="ml-2 text-warning font-medium">{totalStuck} stuck</span>
          )}
        </span>
      </div>

      {STAGES.map((stage) => {
        const items = buckets[stage];
        if (items.length === 0) return null;
        const cfg = canonicalConfig(stage);
        const Icon = STAGE_ICONS[stage];
        const next = nextStage(stage);
        const threshold = STALE_DAYS[stage];
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
                const busy = busyId === row.id;
                const days = ageInDays(row.created_at);
                const stuck = days >= threshold;
                return (
                  <li
                    key={row.id}
                    className={cn(
                      'flex items-center gap-3 rounded-md border bg-card px-3 py-2 hover:bg-muted/30 transition-colors',
                      stuck ? 'border-warning/40' : 'border-border/60',
                    )}
                  >
                    <div className={cn('h-2 w-2 rounded-full shrink-0', cfg.dotColor)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground truncate flex items-center gap-1.5">
                        <Link
                          to={`/candidates/${row.candidate_id}`}
                          className="font-medium hover:underline"
                        >
                          {candidateName}
                        </Link>
                        <span className="text-muted-foreground">→</span>
                        <Link to={`/jobs/${row.job_id}`} className="hover:underline">
                          {jobTitle}
                        </Link>
                        {company && (
                          <span className="text-xs text-muted-foreground truncate"> · {company}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {ageLabel(days)} in {cfg.shortLabel.toLowerCase()}
                        </span>
                        {stuck && (
                          <span className="text-[10px] text-warning font-medium flex items-center gap-0.5">
                            <AlertCircle className="h-2.5 w-2.5" /> stuck
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {next && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAdvance(row)}
                          disabled={busy}
                          className="h-7 text-xs"
                        >
                          {busy ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <ArrowRight className="h-3 w-3 mr-1" />
                          )}
                          Move to {canonicalConfig(next).shortLabel}
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" disabled={busy}>
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="text-xs">
                          <DropdownMenuItem asChild>
                            <Link to={`/candidates/${row.candidate_id}`}>Open candidate</Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link to={`/jobs/${row.job_id}`}>Open job</Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => handleWithdraw(row)}
                          >
                            <XCircle className="h-3 w-3 mr-1.5" /> Mark withdrawn
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
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
