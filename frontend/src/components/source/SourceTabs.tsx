import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HorizontalTableScroll } from '@/components/shared/HorizontalTableScroll';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2, Briefcase, User, Martini, MessageSquare, PhoneCall, Mailbox, MoreHorizontal,
  Send, FileText as FileTextIcon, XCircle,
} from 'lucide-react';

async function transitionSourcing(payload: { sourcing_id: string; action: 'withdraw' | 'promote_to_pitch' | 'promote_to_send_out'; reason?: string; notes?: string }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const resp = await fetch('/api/sourcing-transition', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Transition failed (${resp.status})`);
  return data;
}

interface RowActionsProps {
  row: { id: string; stage: string };
  onChanged: () => void;
}

function RowActions({ row, onChanged }: RowActionsProps) {
  const [busy, setBusy] = useState(false);
  const canWithdraw = row.stage === 'replied' || row.stage === 'back_of_resume';
  const canPromote = row.stage === 'back_of_resume';

  const run = async (action: 'withdraw' | 'promote_to_pitch' | 'promote_to_send_out') => {
    setBusy(true);
    try {
      let reason: string | undefined;
      if (action === 'withdraw') {
        const r = window.prompt('Withdrawal reason (optional)') ?? undefined;
        reason = r || undefined;
      }
      await transitionSourcing({ sourcing_id: row.id, action, reason });
      toast.success(
        action === 'withdraw' ? 'Withdrawn from sourcing'
        : action === 'promote_to_pitch' ? 'Moved to pitch'
        : 'Moved to send-out'
      );
      onChanged();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  if (!canWithdraw && !canPromote) {
    // Nothing actionable yet — keep the menu hidden so the row stays clean.
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={busy} className="h-7 w-7 p-0">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canPromote && (
          <>
            <DropdownMenuItem onClick={() => run('promote_to_pitch')}>
              <FileTextIcon className="h-3.5 w-3.5 mr-2" />
              Move to pitch
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run('promote_to_send_out')}>
              <Send className="h-3.5 w-3.5 mr-2" />
              Move to send-out
            </DropdownMenuItem>
          </>
        )}
        {canPromote && canWithdraw && <DropdownMenuSeparator />}
        {canWithdraw && (
          <DropdownMenuItem onClick={() => run('withdraw')} className="text-red-500">
            <XCircle className="h-3.5 w-3.5 mr-2" />
            Withdraw
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared stage definitions                                           */
/* ------------------------------------------------------------------ */

export const SOURCING_STAGES = ['uncontacted', 'contacted', 'replied', 'back_of_resume'] as const;
export type SourcingStage = (typeof SOURCING_STAGES)[number];

const STAGE_META: Record<SourcingStage, { label: string; cls: string; icon: any }> = {
  uncontacted:    { label: 'Uncontacted',   cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20',          icon: Mailbox },
  contacted:      { label: 'Contacted',     cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',   icon: MessageSquare },
  replied:        { label: 'Replied',       cls: 'bg-green-500/10 text-green-400 border-green-500/20',      icon: Martini },
  back_of_resume: { label: 'Back of resume',cls: 'bg-purple-500/10 text-purple-400 border-purple-500/20',   icon: PhoneCall },
};

function stageEnteredAt(row: any, stage: SourcingStage): string | null {
  return row?.[`${stage}_at`] ?? null;
}

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

interface SourcingRow {
  id: string;
  candidate_id: string;
  job_id: string;
  stage: SourcingStage;
  uncontacted_at: string;
  contacted_at: string | null;
  replied_at: string | null;
  back_of_resume_at: string | null;
  withdrawn_at: string | null;
  promoted_at: string | null;
  promoted_to: string | null;
  candidate?: { first_name?: string; last_name?: string; full_name?: string; linkedin_url?: string; avatar_url?: string; current_title?: string; current_company?: string };
  job?: { title?: string; company_name?: string; company?: string };
}

/* ------------------------------------------------------------------ */
/*  JobSourceTab — pipeline view scoped to one job                     */
/* ------------------------------------------------------------------ */

export function JobSourceTab({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<SourcingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('sourcing')
      .select(`
        id, candidate_id, job_id, stage,
        uncontacted_at, contacted_at, replied_at, back_of_resume_at,
        withdrawn_at, promoted_at, promoted_to,
        candidate:people!sourcing_candidate_id_fkey (
          first_name, last_name, full_name, linkedin_url, avatar_url,
          current_title, current_company
        )
      `)
      .eq('job_id', jobId)
      .is('withdrawn_at', null)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Failed to load sourcing for job', error);
      setRows([]);
    } else {
      setRows((data || []) as any);
    }
    setLoading(false);
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const onChanged = useCallback(() => {
    load();
    queryClient.invalidateQueries({ queryKey: ['send-outs'] });
    queryClient.invalidateQueries({ queryKey: ['pitches'] });
  }, [load, queryClient]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
        Loading sourcing…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        No candidates sourced for this job yet. Save someone from a LinkedIn project to start the funnel.
      </div>
    );
  }

  const byStage: Record<SourcingStage, SourcingRow[]> = {
    uncontacted: [], contacted: [], replied: [], back_of_resume: [],
  };
  for (const r of rows) byStage[r.stage]?.push(r);

  return (
    <div className="space-y-6 p-6">
      <div className="flex gap-3 flex-wrap">
        {SOURCING_STAGES.map((stage) => {
          const meta = STAGE_META[stage];
          const Icon = meta.icon;
          return (
            <div key={stage} className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${meta.cls}`}>
              <Icon className="h-3.5 w-3.5" />
              <span className="text-sm font-medium">{meta.label}</span>
              <span className="text-lg font-bold">{byStage[stage].length}</span>
            </div>
          );
        })}
      </div>

      {SOURCING_STAGES.map((stage) => {
        const items = byStage[stage];
        if (items.length === 0) return null;
        const meta = STAGE_META[stage];
        return (
          <div key={stage} className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 bg-card border-b border-border">
              <Badge className={meta.cls}>{meta.label}</Badge>
              <span className="text-xs text-muted-foreground">{items.length} candidate{items.length === 1 ? '' : 's'}</span>
            </div>
            <HorizontalTableScroll minWidth={760}>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-left">Candidate</th>
                  <th className="px-3 py-2 text-left">Title</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-left">Entered stage</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const c = r.candidate || {};
                  const name = (c.full_name || `${c.first_name || ''} ${c.last_name || ''}`).trim() || 'Unnamed';
                  return (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-accent/5">
                      <td className="px-3 py-2">
                        <Link to={`/candidates/${r.candidate_id}`} className="flex items-center gap-2 hover:underline">
                          {c.avatar_url
                            ? <img src={c.avatar_url} alt="" className="h-6 w-6 rounded-full object-cover" />
                            : <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px]">{(c.first_name?.[0] || '') + (c.last_name?.[0] || '') || <User className="h-3 w-3" />}</div>}
                          <span className="font-medium truncate">{name}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[200px]">{c.current_title || '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground truncate max-w-[180px]">{c.current_company || '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">{fmtRel(stageEnteredAt(r, stage))}</td>
                      <td className="px-2 py-2 text-right">
                        <RowActions row={{ id: r.id, stage: r.stage }} onChanged={onChanged} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </HorizontalTableScroll>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CandidateSourceTab — every job this person is sourced for          */
/* ------------------------------------------------------------------ */

export function CandidateSourceTab({ candidateId }: { candidateId: string }) {
  const [rows, setRows] = useState<SourcingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('sourcing')
      .select(`
        id, candidate_id, job_id, stage,
        uncontacted_at, contacted_at, replied_at, back_of_resume_at,
        withdrawn_at, promoted_at, promoted_to,
        job:jobs!sourcing_job_id_fkey (
          title, company_name, company
        )
      `)
      .eq('candidate_id', candidateId)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Failed to load sourcing for candidate', error);
      setRows([]);
    } else {
      setRows((data || []) as any);
    }
    setLoading(false);
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  const onChanged = useCallback(() => {
    load();
    queryClient.invalidateQueries({ queryKey: ['send-outs'] });
    queryClient.invalidateQueries({ queryKey: ['pitches'] });
  }, [load, queryClient]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
        Loading sourcing…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Not sourced for any job yet.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-6">
      {rows.map((r) => {
        const meta = STAGE_META[r.stage];
        const j = r.job || {};
        const company = j.company_name || j.company || '—';
        const entered = stageEnteredAt(r, r.stage);
        return (
          <div
            key={r.id}
            className={`flex items-center gap-3 px-4 py-3 bg-card border border-border rounded-lg ${r.withdrawn_at ? 'opacity-60' : ''}`}
          >
            <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <Link to={`/jobs/${r.job_id}`} className="font-medium hover:underline">
                {j.title || 'Untitled job'}
              </Link>
              <div className="text-xs text-muted-foreground truncate">{company}</div>
            </div>
            <Badge className={meta.cls + ' shrink-0'}>{meta.label}</Badge>
            <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
              {fmtRel(entered)}
            </span>
            {r.withdrawn_at && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">withdrawn</Badge>
            )}
            {r.promoted_to && (
              <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/30 shrink-0">
                → {r.promoted_to}
              </Badge>
            )}
            <RowActions row={{ id: r.id, stage: r.stage }} onChanged={onChanged} />
          </div>
        );
      })}
    </div>
  );
}
