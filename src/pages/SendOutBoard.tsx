import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { EntityAvatar } from '@/components/shared/EntityAvatar';
import { SendOutDrawer } from '@/components/sendouts/SendOutDrawer';
import {
  SEND_OUT_STAGES,
  STAGE_LABEL,
  STAGE_COLUMN_ACCENT,
  type SendOutStage,
} from '@/components/sendouts/sendOutStages';
import { useSendOutBoardRows, type SendOutBoardRow } from '@/components/sendouts/useSendOutData';
import { useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Loader2, Search, X } from 'lucide-react';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';

function daysInStage(row: SendOutBoardRow): number {
  const ref = row.updated_at || row.created_at;
  if (!ref) return 0;
  try {
    return Math.max(0, differenceInCalendarDays(new Date(), parseISO(ref)));
  } catch {
    return 0;
  }
}

export default function SendOutBoardPage() {
  const { data: rows = [], isLoading } = useSendOutBoardRows();
  const { data: jobs = [] } = useJobs(true);
  const { data: profiles = [] } = useProfiles();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [jobFilter, setJobFilter] = useState<string>('all');
  const [recruiterFilter, setRecruiterFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<'all' | '7d' | '30d' | '90d'>('all');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('id');

  const openDrawer = (id: string) => {
    searchParams.set('id', id);
    setSearchParams(searchParams, { replace: true });
  };
  const closeDrawer = () => {
    searchParams.delete('id');
    setSearchParams(searchParams, { replace: true });
  };

  const filtered = useMemo(() => {
    const cutoff = (() => {
      if (dateFilter === 'all') return null;
      const days = dateFilter === '7d' ? 7 : dateFilter === '30d' ? 30 : 90;
      return Date.now() - days * 86400 * 1000;
    })();
    return rows.filter((r) => {
      if (jobFilter !== 'all' && r.job_id !== jobFilter) return false;
      if (recruiterFilter !== 'all' && r.recruiter_id !== recruiterFilter) return false;
      if (cutoff && r.updated_at && new Date(r.updated_at).getTime() < cutoff) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const hay = `${r.candidate_name ?? ''} ${r.job_title ?? ''} ${r.company_name ?? ''} ${r.recruiter_name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, jobFilter, recruiterFilter, dateFilter]);

  const grouped = useMemo(() => {
    const map: Record<SendOutStage, SendOutBoardRow[]> = {
      send_out: [], submitted: [], interviewing: [], offer: [], placed: [], rejected: [], withdrawn: [],
    };
    for (const row of filtered) {
      const stage = (row.stage as SendOutStage) ?? 'send_out';
      (map[stage] ?? (map[stage] = [])).push(row);
    }
    return map;
  }, [filtered]);

  const moveStage = async (row: SendOutBoardRow, direction: -1 | 1) => {
    const idx = SEND_OUT_STAGES.indexOf(row.stage as SendOutStage);
    if (idx < 0) return;
    const next = SEND_OUT_STAGES[idx + direction];
    if (!next) return;
    await updateStage(row.id, next, row.stage);
  };

  const updateStage = async (id: string, toStage: string, fromStage?: string) => {
    setUpdatingId(id);
    try {
      const { error } = await supabase.from('send_outs').update({ stage: toStage }).eq('id', id);
      if (error) throw error;

      // Log this move so the drawer's history panel shows where it came from.
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('stage_transitions').insert({
        entity_type: 'send_out',
        entity_id: id,
        from_stage: fromStage ?? null,
        to_stage: toStage,
        moved_by: 'human',
        triggered_by_user_id: userData.user?.id ?? null,
        trigger_source: 'board',
      });

      qc.invalidateQueries({ queryKey: ['send_out_rows'] });
      qc.invalidateQueries({ queryKey: ['send_out_row', id] });
      qc.invalidateQueries({ queryKey: ['stage_transitions', 'send_out', id] });
      toast.success(`Moved to ${STAGE_LABEL[toStage as SendOutStage] ?? toStage}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update stage');
    } finally {
      setUpdatingId(null);
    }
  };

  // Drag & drop
  const onDragStart = (e: React.DragEvent, row: SendOutBoardRow) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ id: row.id, stage: row.stage }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e: React.DragEvent, toStage: SendOutStage) => {
    e.preventDefault();
    try {
      const payload = JSON.parse(e.dataTransfer.getData('text/plain')) as { id: string; stage: string };
      if (payload.stage === toStage) return;
      updateStage(payload.id, toStage, payload.stage);
    } catch {
      /* ignore */
    }
  };

  const clearFilters = () => {
    setSearch('');
    setJobFilter('all');
    setRecruiterFilter('all');
    setDateFilter('all');
  };

  return (
    <MainLayout>
      <PageHeader
        title="Send Outs"
        description="Pipeline of candidates submitted to client jobs"
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-8 py-4 border-b border-border bg-card">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search candidate, job, company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 w-64 h-8"
          />
        </div>

        <Select value={jobFilter} onValueChange={setJobFilter}>
          <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Job" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All jobs</SelectItem>
            {jobs.map((j: any) => (
              <SelectItem key={j.id} value={j.id}>
                {j.title}{j.companies?.name ? ` — ${j.companies.name}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={recruiterFilter} onValueChange={setRecruiterFilter}>
          <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Recruiter" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All recruiters</SelectItem>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.full_name || p.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as typeof dateFilter)}>
          <SelectTrigger className="h-8 w-40"><SelectValue placeholder="Date" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
          </SelectContent>
        </Select>

        {(search || jobFilter !== 'all' || recruiterFilter !== 'all' || dateFilter !== 'all') && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8">
            <X className="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
        )}

        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {rows.length}
        </div>
      </div>

      {/* Kanban */}
      <div className="p-6 overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <div className="flex gap-4 min-w-max pb-4">
            {SEND_OUT_STAGES.map((stage) => {
              const cards = grouped[stage] ?? [];
              return (
                <div
                  key={stage}
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(e, stage)}
                  className={cn(
                    'w-72 shrink-0 rounded-lg bg-muted/30 border border-border border-t-4 flex flex-col',
                    STAGE_COLUMN_ACCENT[stage],
                  )}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
                      {STAGE_LABEL[stage]}
                    </div>
                    <div className="text-[10px] font-medium text-muted-foreground bg-background border border-border rounded-full px-2 py-0.5">
                      {cards.length}
                    </div>
                  </div>

                  <div className="flex-1 min-h-[120px] p-2 space-y-2">
                    {cards.length === 0 && (
                      <div className="text-center py-8 text-[11px] text-muted-foreground">No records</div>
                    )}
                    {cards.map((row) => {
                      const stageIdx = SEND_OUT_STAGES.indexOf(stage);
                      const canBack = stageIdx > 0;
                      const canForward = stageIdx < SEND_OUT_STAGES.length - 1;
                      return (
                        <div
                          key={row.id}
                          draggable
                          onDragStart={(e) => onDragStart(e, row)}
                          onClick={() => openDrawer(row.id)}
                          className="group cursor-grab active:cursor-grabbing rounded-md border border-border bg-background p-3 hover:shadow-md hover:border-emerald-700/40 transition-all"
                        >
                          <div className="flex items-start gap-2.5">
                            <EntityAvatar
                              avatarUrl={row.candidate_avatar_url}
                              email={row.candidate_email}
                              name={row.candidate_name}
                              size="md"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold truncate">{row.candidate_name || 'Unknown'}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {row.job_title || 'No job'}
                              </div>
                              {row.company_name && (
                                <div className="text-[11px] text-muted-foreground truncate">{row.company_name}</div>
                              )}
                            </div>
                          </div>

                          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {row.recruiter_id && (
                                <EntityAvatar
                                  avatarUrl={row.recruiter_avatar_url}
                                  name={row.recruiter_name}
                                  size="sm"
                                />
                              )}
                              <span className="truncate">{row.recruiter_name || '—'}</span>
                            </div>
                            <span className="shrink-0">{daysInStage(row)}d</span>
                          </div>

                          <div className="mt-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              title="Move back"
                              disabled={!canBack || updatingId === row.id}
                              onClick={(e) => { e.stopPropagation(); moveStage(row, -1); }}
                              className="p-1 rounded hover:bg-muted disabled:opacity-30"
                            >
                              <ArrowLeft className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Move forward"
                              disabled={!canForward || updatingId === row.id}
                              onClick={(e) => { e.stopPropagation(); moveStage(row, 1); }}
                              className="p-1 rounded hover:bg-muted disabled:opacity-30"
                            >
                              <ArrowRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <SendOutDrawer
        sendOutId={selectedId}
        open={!!selectedId}
        onClose={closeDrawer}
      />
    </MainLayout>
  );
}
