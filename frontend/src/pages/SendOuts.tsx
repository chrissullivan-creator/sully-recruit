import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Plus, Loader2, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { useSendOuts, type SendOutRow } from '@/lib/queries/send-outs';
import { CANONICAL_PIPELINE, stageToCanonical, nextStage, type CanonicalStage } from '@/lib/pipeline';
import { KpiTiles } from '@/components/send-outs/KpiTiles';
import { FilterBar, EMPTY_FILTERS, type SendOutsFilters } from '@/components/send-outs/FilterBar';
import { StageTable } from '@/components/send-outs/StageTable';

// Pull filter state out of URL params on mount and write back when it changes —
// makes filter state shareable.
function readFiltersFromUrl(sp: URLSearchParams): SendOutsFilters {
  return {
    q:           sp.get('q') ?? '',
    jobId:       sp.get('jobId') ?? 'all',
    recruiterId: sp.get('recruiterId') ?? 'all',
    from:        sp.get('from') ?? '',
    to:          sp.get('to') ?? '',
  };
}

function writeFiltersToUrl(f: SendOutsFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q)                     sp.set('q', f.q);
  if (f.jobId !== 'all')       sp.set('jobId', f.jobId);
  if (f.recruiterId !== 'all') sp.set('recruiterId', f.recruiterId);
  if (f.from)                  sp.set('from', f.from);
  if (f.to)                    sp.set('to', f.to);
  return sp;
}

export default function SendOuts() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: rows = [], isLoading } = useSendOuts();
  const { data: jobs = [] } = useJobs(true);
  const { data: profiles = [] } = useProfiles();
  const recruiters = profiles.map((p: any) => ({ id: p.id, full_name: p.full_name }));

  const [filters, setFilters] = useState<SendOutsFilters>(() => readFiltersFromUrl(searchParams));
  const [openStages, setOpenStages] = useState<Set<CanonicalStage>>(new Set(CANONICAL_PIPELINE.slice(0, 5).map((s) => s.key)));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Honour ?stage= param from dashboard cards: open + scroll that stage.
  useEffect(() => {
    const stageParam = searchParams.get('stage');
    if (!stageParam) return;
    const canonical = stageToCanonical(stageParam);
    if (canonical) setOpenStages((prev) => new Set([...prev, canonical]));
  }, [searchParams]);

  // Persist filters to the URL (preserve any non-filter params like ?stage=).
  useEffect(() => {
    const next = writeFiltersToUrl(filters);
    const stageParam = searchParams.get('stage');
    if (stageParam) next.set('stage', stageParam);
    setSearchParams(next, { replace: true });
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply filters to rows.
  const filteredRows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const fromMs = filters.from ? new Date(filters.from).getTime() : 0;
    const toMs   = filters.to   ? new Date(filters.to).getTime() + 86_400_000 : Number.POSITIVE_INFINITY;

    return rows.filter((r) => {
      if (filters.jobId !== 'all' && r.job_id !== filters.jobId) return false;
      if (filters.recruiterId !== 'all' && r.recruiter_id !== filters.recruiterId) return false;
      const ts = new Date(r.updated_at ?? r.created_at).getTime();
      if (ts < fromMs || ts > toMs) return false;
      if (q) {
        const hay = [
          r.candidate?.full_name, r.candidate?.first_name, r.candidate?.last_name,
          r.candidate?.current_title, r.candidate?.current_company,
          r.job?.title, r.job?.company_name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filters]);

  // Group by canonical stage.
  const rowsByStage = useMemo(() => {
    const map = new Map<CanonicalStage, SendOutRow[]>();
    for (const s of CANONICAL_PIPELINE) map.set(s.key, []);
    for (const r of filteredRows) {
      const c = stageToCanonical(r.stage);
      if (c) map.get(c)!.push(r);
    }
    return map;
  }, [filteredRows]);

  // Estimated fee sum for the offer-stage tile (25% of target comp midpoint).
  const offerFee = useMemo(() => {
    const offers = rowsByStage.get('offer') ?? [];
    return offers.reduce((sum, r) => {
      const comp = r.candidate?.target_total_comp ?? r.candidate?.target_base_comp ?? 0;
      return sum + comp * 0.25;
    }, 0);
  }, [rowsByStage]);

  const toggleStageOpen = (key: CanonicalStage) =>
    setOpenStages((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const expandAll   = () => setOpenStages(new Set(CANONICAL_PIPELINE.map((s) => s.key)));
  const collapseAll = () => setOpenStages(new Set());

  const handleTileClick = (target: 'all' | 'submitted' | 'interviewing' | 'offer') => {
    if (target === 'all') return expandAll();
    const targets: CanonicalStage[] =
      target === 'submitted'    ? ['submitted'] :
      target === 'interviewing' ? ['interview_round_1', 'interview_round_2_plus'] :
      target === 'offer'        ? ['offer'] : [];
    setOpenStages(new Set(targets));
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Optimistic stage advance — write to send_outs, log in status_change_log.
  const handleAdvance = async (row: SendOutRow) => {
    const current = stageToCanonical(row.stage);
    if (!current) return;
    const nextK = nextStage(current);
    if (!nextK) { toast.info('Already at the final stage.'); return; }
    // Optimistic — TODO: full optimistic UI in the next pass once DnD is in.
    const { error } = await supabase.from('send_outs').update({ stage: nextK }).eq('id', row.id);
    if (error) { toast.error(error.message); return; }
    toast.success(`Advanced to ${nextK.replace(/_/g, ' ')}`);
    // React-query invalidation handled by parent next pass; for now reload via refetch.
    window.location.reload();
  };

  const handleOpenRow = (row: SendOutRow) => {
    // Drawer comes in next pass — for now navigate to the candidate page.
    if (row.candidate?.id) {
      navigate(row.candidate.type === 'client' ? `/contacts/${row.candidate.id}` : `/candidates/${row.candidate.id}`);
    }
  };

  const exportCsv = () => {
    const header = ['Stage', 'Candidate', 'Current Title', 'Company', 'Job', 'Target Comp', 'Updated'];
    const lines = filteredRows.map((r) => [
      r.stage, r.candidate?.full_name ?? '', r.candidate?.current_title ?? '',
      r.candidate?.current_company ?? '', r.job?.title ?? '',
      String(r.candidate?.target_total_comp ?? ''), r.updated_at ?? '',
    ].map((v) => `"${(v ?? '').toString().replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `send-outs-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const allOpen = openStages.size === CANONICAL_PIPELINE.length;

  return (
    <MainLayout>
      <PageHeader
        title="Send Outs"
        description="Every active send-out across the team — group, filter, advance."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={allOpen ? collapseAll : expandAll} className="gap-1">
              {allOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1">
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button variant="gold" size="sm" onClick={() => toast.info('Add Send Out — wired in the next pass.')} className="gap-1">
              <Plus className="h-3.5 w-3.5" /> New Send Out
            </Button>
          </div>
        }
      />

      <div className="bg-page-bg min-h-[calc(100vh-4rem)] p-6 lg:p-8 space-y-6">
        <KpiTiles rows={filteredRows} onTileClick={handleTileClick} offerFee={offerFee} />

        <FilterBar
          filters={filters}
          onChange={setFilters}
          jobs={jobs as any[]}
          recruiters={recruiters}
        />

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading send-outs…
          </div>
        ) : (
          <div className="space-y-3">
            {CANONICAL_PIPELINE.map((cfg) => (
              <StageTable
                key={cfg.key}
                config={cfg}
                rows={rowsByStage.get(cfg.key) ?? []}
                isOpen={openStages.has(cfg.key)}
                onToggle={() => toggleStageOpen(cfg.key)}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onAdvance={handleAdvance}
                onOpen={handleOpenRow}
                onAdd={() => toast.info('Add to ' + cfg.label + ' — wired in the next pass.')}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filteredRows.length === 0 && (
          <div className="rounded-xl border border-dashed border-card-border bg-white py-16 text-center">
            <p className="text-sm font-medium text-foreground">No send-outs match these filters.</p>
            <p className="text-xs text-muted-foreground mt-1">Clear filters or click "New Send Out" to start one.</p>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
