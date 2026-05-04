import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MainLayout } from '@/components/layout/MainLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Plus, Loader2, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  pointerWithin, type DragStartEvent, type DragEndEvent, type DragOverEvent,
} from '@dnd-kit/core';
import { useJobs } from '@/hooks/useData';
import { useProfiles } from '@/hooks/useProfiles';
import { useSendOuts, type SendOutRow } from '@/lib/queries/send-outs';
import { CANONICAL_PIPELINE, stageToCanonical, nextStage, canonicalConfig, type CanonicalStage } from '@/lib/pipeline';
import { moveStage } from '@/lib/mutations/move-stage';
import { KpiTiles } from '@/components/send-outs/KpiTiles';
import { FilterBar, type SendOutsFilters } from '@/components/send-outs/FilterBar';
import { StageTable } from '@/components/send-outs/StageTable';
import { CandidateDrawer } from '@/components/candidate/CandidateDrawer';
import { AddCandidateModal } from '@/components/candidate/AddCandidateModal';
import { BulkActionBar } from '@/components/send-outs/BulkActionBar';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { softDelete } from '@/lib/softDelete';
import { ListSkeleton } from '@/components/shared/EmptyState';

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
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: rows = [], isLoading } = useSendOuts();
  const { data: jobs = [] } = useJobs(true);
  const { data: profiles = [] } = useProfiles();
  const recruiters = profiles.map((p: any) => ({ id: p.id, full_name: p.full_name }));

  const [filters, setFilters] = useState<SendOutsFilters>(() => readFiltersFromUrl(searchParams));
  const [openStages, setOpenStages] = useState<Set<CanonicalStage>>(new Set(CANONICAL_PIPELINE.slice(0, 5).map((s) => s.key)));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drawerRow, setDrawerRow] = useState<SendOutRow | null>(null);
  const [addModal, setAddModal] = useState<{ open: boolean; stage: CanonicalStage; jobId: string | null }>({
    open: false, stage: 'pitch', jobId: null,
  });
  const [activeDrag, setActiveDrag] = useState<SendOutRow | null>(null);
  const [overStage, setOverStage] = useState<CanonicalStage | null>(null);
  const [deleteRow, setDeleteRow] = useState<SendOutRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

  const rowsByStage = useMemo(() => {
    const map = new Map<CanonicalStage, SendOutRow[]>();
    for (const s of CANONICAL_PIPELINE) map.set(s.key, []);
    for (const r of filteredRows) {
      const c = stageToCanonical(r.stage);
      if (c) map.get(c)!.push(r);
    }
    return map;
  }, [filteredRows]);

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

  // Optimistic stage move with rollback on error. Used by the Advance arrow.
  const handleAdvance = async (row: SendOutRow) => {
    const current = stageToCanonical(row.stage);
    if (!current) return;
    const nextK = nextStage(current);
    if (!nextK) { toast.info('Already at the final stage.'); return; }
    await commitMove(row, nextK, 'advance');
  };

  const commitMove = async (row: SendOutRow, target: CanonicalStage, source: string) => {
    // Optimistic patch — react-query cache update.
    queryClient.setQueryData<SendOutRow[]>(['send_outs_list'], (prev = []) =>
      prev.map((r) => (r.id === row.id ? { ...r, stage: target } : r)),
    );
    const res = await moveStage({
      sendOutId: row.id,
      candidateJobId: (row as any).candidate_job_id ?? null,
      fromStage: row.stage,
      toStage: target,
      triggerSource: source,
      entityId: row.candidate?.id ?? null,
      entityType: 'send_out',
    });
    if (!res.ok) {
      // Roll back.
      queryClient.setQueryData<SendOutRow[]>(['send_outs_list'], (prev = []) =>
        prev.map((r) => (r.id === row.id ? { ...r, stage: row.stage } : r)),
      );
      toast.error(res.error ?? 'Move failed');
      return;
    }
    toast.success(`Moved to ${canonicalConfig(target).label}`);
    queryClient.invalidateQueries({ queryKey: ['dashboard_metrics'] });
  };

  const handleOpenRow = (row: SendOutRow) => setDrawerRow(row);

  const handleDeleteRow = async () => {
    if (!deleteRow) return;
    setDeleting(true);
    try {
      const { error } = await softDelete('send_outs', deleteRow.id);
      if (error) throw new Error(error.message);
      toast.success('Removed from pipeline');
      invalidateSendOutScope(queryClient);
      setDeleteRow(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove');
    } finally {
      setDeleting(false);
    }
  };

  // ── Drag & drop ──────────────────────────────────────────────────────
  const handleDragStart = (e: DragStartEvent) => {
    const row = filteredRows.find((r) => r.id === e.active.id);
    setActiveDrag(row ?? null);
  };
  const handleDragOver = (e: DragOverEvent) => {
    const overId = e.over?.id;
    if (typeof overId !== 'string') { setOverStage(null); return; }
    if (overId.startsWith('stage:')) {
      setOverStage(overId.slice('stage:'.length) as CanonicalStage);
    } else if (overId.startsWith('kpi-tile:') && !overId.startsWith('kpi-tile:noop:')) {
      setOverStage(overId.slice('kpi-tile:'.length) as CanonicalStage);
    } else {
      setOverStage(null);
    }
  };
  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveDrag(null);
    setOverStage(null);
    const overId = e.over?.id;
    if (typeof overId !== 'string') return;
    let target: CanonicalStage | null = null;
    if (overId.startsWith('stage:'))                                       target = overId.slice('stage:'.length) as CanonicalStage;
    else if (overId.startsWith('kpi-tile:') && !overId.startsWith('kpi-tile:noop:')) target = overId.slice('kpi-tile:'.length) as CanonicalStage;
    if (!target) return;
    const row = filteredRows.find((r) => r.id === e.active.id);
    if (!row) return;
    if (stageToCanonical(row.stage) === target) return;
    // Auto-expand the destination so the user sees the drop.
    setOpenStages((prev) => new Set([...prev, target!]));
    await commitMove(row, target, 'drag');
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
        description="Every active send-out across the team — drag to advance, click to open."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={allOpen ? collapseAll : expandAll} className="gap-1">
              {allOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} className="gap-1">
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button variant="gold" size="sm" onClick={() => setAddModal({ open: true, stage: 'pitch', jobId: filters.jobId !== 'all' ? filters.jobId : null })} className="gap-1">
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
          <ListSkeleton rows={5} />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => { setActiveDrag(null); setOverStage(null); }}
          >
            <div className="space-y-3">
              {CANONICAL_PIPELINE.map((cfg) => (
                <StageTable
                  key={cfg.key}
                  config={cfg}
                  rows={rowsByStage.get(cfg.key) ?? []}
                  isOpen={openStages.has(cfg.key) || overStage === cfg.key}
                  isOver={overStage === cfg.key}
                  onToggle={() => toggleStageOpen(cfg.key)}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onAdvance={handleAdvance}
                  onOpen={handleOpenRow}
                  onAdd={() => setAddModal({ open: true, stage: cfg.key, jobId: filters.jobId !== 'all' ? filters.jobId : null })}
                  onDelete={(row) => setDeleteRow(row)}
                />
              ))}
            </div>

            <DragOverlay>
              {activeDrag && (
                <div className="rounded-lg border border-emerald bg-white shadow-xl px-3 py-2 text-sm font-medium text-emerald-dark">
                  {activeDrag.candidate?.full_name ?? '—'}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}

        {!isLoading && filteredRows.length === 0 && (
          <div className="rounded-xl border border-dashed border-card-border bg-white py-16 text-center">
            <p className="text-sm font-medium text-foreground">No send-outs match these filters.</p>
            <p className="text-xs text-muted-foreground mt-1">Clear filters or click "New Send Out" to start one.</p>
          </div>
        )}
      </div>

      <BulkActionBar
        selectedRows={filteredRows.filter((r) => selectedIds.has(r.id))}
        onClear={() => setSelectedIds(new Set())}
      />

      <CandidateDrawer
        row={drawerRow}
        onClose={() => setDrawerRow(null)}
        invalidateKeys={[['send_outs_list'], ['dashboard_metrics']]}
      />

      <AddCandidateModal
        open={addModal.open}
        onOpenChange={(v) => setAddModal((prev) => ({ ...prev, open: v }))}
        jobId={addModal.jobId}
        stage={addModal.stage}
      />

      <AlertDialog open={!!deleteRow} onOpenChange={(v) => { if (!v) setDeleteRow(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <span className="font-semibold">{deleteRow?.candidate?.full_name ?? 'this candidate'}</span>
              {' '}from the {deleteRow?.job?.title ?? 'job'} pipeline. The person record stays — only this send-out is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRow} disabled={deleting} className="bg-red-600 hover:bg-red-700">
              {deleting ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
