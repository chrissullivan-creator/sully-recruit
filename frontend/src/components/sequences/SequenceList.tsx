import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, BarChart3, Calendar, Pause, Play, Loader2, Archive, Trash2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/api-auth";
import { PageHeader } from "@/components/layout/PageHeader";
import { SectionCard } from "@/components/shared/SectionCard";
import { StatStrip } from "@/components/shared/StatStrip";
import { EnrolledPeopleDialog } from "./EnrolledPeopleDialog";

interface SequenceRow {
  id: string;
  name: string;
  audience_type: string;
  status: string;
  created_at: string;
  job_id: string | null;
  jobs?: { title: string } | null;
  _enrollmentCount?: number;
  _activeCount?: number;
}

export function SequenceList() {
  const [sequences, setSequences] = useState<SequenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drillSequence, setDrillSequence] = useState<SequenceRow | null>(null);
  // Tracks per-row pause/resume mutation state so we can disable
  // the buttons + show a spinner.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bulk-selection state.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function handlePause(seq: SequenceRow) {
    setBusyId(seq.id);
    try {
      const { error } = await supabase
        .from("sequences")
        .update({ status: "paused", updated_at: new Date().toISOString() } as any)
        .eq("id", seq.id);
      if (error) throw error;
      toast.success("Sequence paused — sends will halt within 3 minutes");
      await loadSequences();
    } catch (err: any) {
      toast.error(err?.message || "Failed to pause");
    } finally {
      setBusyId(null);
    }
  }

  async function handleResume(seq: SequenceRow) {
    setBusyId(seq.id);
    try {
      const { error } = await supabase
        .from("sequences")
        .update({ status: "active", updated_at: new Date().toISOString() } as any)
        .eq("id", seq.id);
      if (error) throw error;
      // Re-pace active enrollments so unsent steps schedule from
      // NOW (not the stale last_sent_at + delay, which would
      // typically land in the past after a long pause).
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) {
        const resp = await fetch("/api/replace-sequence-enrollments", {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({ sequence_id: seq.id, enrolled_by: user.id, force_imminent: true }),
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);
        toast.success(`Resumed and re-paced ${result.repaced ?? 0} enrollment${result.repaced === 1 ? "" : "s"}`);
      } else {
        toast.success("Sequence resumed");
      }
      await loadSequences();
    } catch (err: any) {
      toast.error(err?.message || "Failed to resume");
    } finally {
      setBusyId(null);
    }
  }

  const toggleSelect = (seqId: string) =>
    setSelectedIds((prev) => (prev.includes(seqId) ? prev.filter((x) => x !== seqId) : [...prev, seqId]));
  const allSelected = sequences.length > 0 && sequences.every((s) => selectedIds.includes(s.id));
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : sequences.map((s) => s.id));
  const clearSelection = () => setSelectedIds([]);

  async function bulkSetStatus(status: "active" | "paused" | "archived") {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status === "archived") patch.archived_at = new Date().toISOString();
      if (status === "active") patch.archived_at = null; // un-archive on re-activate
      const { error } = await supabase.from("sequences").update(patch as any).in("id", selectedIds);
      if (error) throw error;

      // Activating also starts any enrollments that were attached while the
      // sequence was a draft (status='paused' — e.g. BD-sequence contacts). The
      // endpoint promotes those to active + schedules them from now, and leaves
      // already-running enrollments untouched.
      let started = 0;
      if (status === "active") {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.id) {
          const headers = await authHeaders();
          const settled = await Promise.allSettled(
            selectedIds.map((sid) =>
              fetch("/api/replace-sequence-enrollments", {
                method: "POST",
                headers,
                body: JSON.stringify({ sequence_id: sid, enrolled_by: user.id, force_imminent: true, activate_paused: true }),
              }).then((r) => (r.ok ? r.json() : null)),
            ),
          );
          for (const s of settled) if (s.status === "fulfilled" && s.value?.started) started += s.value.started;
        }
      }

      const verb = status === "active" ? "activated" : status === "paused" ? "paused" : "archived";
      toast.success(
        `${selectedIds.length} sequence${selectedIds.length === 1 ? "" : "s"} ${verb}` +
          (started > 0 ? ` — ${started} enrollment${started === 1 ? "" : "s"} started` : ""),
      );
      clearSelection();
      await loadSequences();
    } catch (err: any) {
      toast.error(err?.message || "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const { error } = await supabase.from("sequences").delete().in("id", selectedIds);
      if (error) throw error;
      toast.success(`${selectedIds.length} sequence${selectedIds.length === 1 ? "" : "s"} deleted`);
      clearSelection();
      await loadSequences();
    } catch (err: any) {
      toast.error(
        /foreign key|violates/i.test(err?.message || "")
          ? "Some sequences have enrollment history and can't be hard-deleted — archive them instead."
          : err?.message || "Bulk delete failed",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  useEffect(() => {
    loadSequences();
  }, []);

  async function loadSequences() {
    try {
      const { data, error } = await supabase
        .from("sequences")
        .select("id, name, audience_type, status, created_at, job_id, jobs(title)")
        .order("created_at", { ascending: false }) as any;

      if (error) throw error;

      // Enrollment counts in ONE query (was 2 per sequence = N+1). Aggregate
      // total + active per sequence_id client-side.
      const seqIds = (data || []).map((s: SequenceRow) => s.id);
      const totals: Record<string, number> = {};
      const actives: Record<string, number> = {};
      if (seqIds.length) {
        const { data: enrollRows, error: enrollErr } = await supabase
          .from("sequence_enrollments")
          .select("sequence_id, status")
          .in("sequence_id", seqIds);
        if (enrollErr) throw enrollErr;
        for (const row of (enrollRows || []) as { sequence_id: string; status: string }[]) {
          totals[row.sequence_id] = (totals[row.sequence_id] || 0) + 1;
          if (row.status === "active") actives[row.sequence_id] = (actives[row.sequence_id] || 0) + 1;
        }
      }
      const enriched = (data || []).map((seq: SequenceRow) => ({
        ...seq,
        _enrollmentCount: totals[seq.id] || 0,
        _activeCount: actives[seq.id] || 0,
      }));
      setSequences(enriched);
    } catch (err: any) {
      console.error("Failed to load sequences:", err);
      toast.error(err?.message || "Failed to load sequences");
    } finally {
      setLoading(false);
    }
  }

  const totalEnrolled = sequences.reduce((sum, s) => sum + (s._enrollmentCount ?? 0), 0);
  const totalActive = sequences.reduce((sum, s) => sum + (s._activeCount ?? 0), 0);
  const liveCount = sequences.filter((s) => s.status === "active").length;

  return (
    <>
      <PageHeader
        eyebrow="Outreach"
        title="Sequences"
        description="Automated multi-channel cadences across email, LinkedIn, and SMS."
        icon={<Workflow />}
        actions={
          <Link to="/sequences/new">
            <Button className="gap-2">
              <Plus className="h-4 w-4" /> New Sequence
            </Button>
          </Link>
        }
      />

      <div className="px-8 py-6 space-y-6">
        {!loading && sequences.length > 0 && (
          <StatStrip
            items={[
              { label: "Sequences", value: sequences.length },
              { label: "Active", value: liveCount, accent: liveCount > 0 },
              { label: "Enrolled", value: totalEnrolled },
              { label: "Live Enrollments", value: totalActive },
            ]}
          />
        )}

        <SectionCard title="All sequences" icon={<Workflow className="h-4 w-4" />} flush>
        {loading ? (
          <p className="text-muted-foreground text-sm p-5">Loading...</p>
        ) : sequences.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Workflow className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="mt-3 font-medium text-foreground">No sequences yet</p>
            <p className="text-sm">Build your first multi-channel outreach cadence.</p>
            <Link to="/sequences/new">
              <Button variant="outline" className="mt-4 gap-2">
                <Plus className="h-4 w-4" /> Create Your First Sequence
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {selectedIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 border-b border-card-border rounded-none bg-accent/5">
                <span className="text-sm font-medium">{selectedIds.length} selected</span>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={bulkBusy} onClick={() => bulkSetStatus("active")}>
                  <Play className="h-3.5 w-3.5" /> Activate
                </Button>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={bulkBusy} onClick={() => bulkSetStatus("paused")}>
                  <Pause className="h-3.5 w-3.5" /> Pause
                </Button>
                <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={bulkBusy} onClick={() => bulkSetStatus("archived")}>
                  <Archive className="h-3.5 w-3.5" /> Archive
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 text-destructive hover:text-destructive" disabled={bulkBusy}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {selectedIds.length} sequence{selectedIds.length === 1 ? "" : "s"}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the sequence{selectedIds.length === 1 ? "" : "s"} and {selectedIds.length === 1 ? "its" : "their"} steps. Sequences with enrollment history can't be hard-deleted — archive those instead. This can't be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={bulkDelete}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                {bulkBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Button variant="ghost" size="sm" className="h-8 ml-auto" onClick={clearSelection}>Clear</Button>
              </div>
            )}
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-5">
                  <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                </TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Name</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Audience</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Job</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Enrolled</TableHead>
                <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Active</TableHead>
                <TableHead className="pr-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((seq) => (
                <TableRow key={seq.id} className={selectedIds.includes(seq.id) ? "bg-accent/5" : undefined}>
                  <TableCell className="pl-5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.includes(seq.id)}
                      onCheckedChange={() => toggleSelect(seq.id)}
                      aria-label={`Select ${seq.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link to={`/sequences/${seq.id}/edit`} className="text-foreground hover:text-primary hover:underline">
                      {seq.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        seq.status === "active"
                          ? "default"
                          : seq.status === "paused"
                            ? "secondary"
                            : "outline"
                      }
                      className="capitalize"
                    >
                      {seq.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{seq.audience_type}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {seq.jobs?.title || "—"}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setDrillSequence(seq)}
                      className={cn(
                        "underline-offset-2 hover:underline text-foreground",
                        (seq._enrollmentCount ?? 0) === 0 && "text-muted-foreground cursor-default no-underline pointer-events-none",
                      )}
                      disabled={(seq._enrollmentCount ?? 0) === 0}
                      title={(seq._enrollmentCount ?? 0) > 0 ? "View enrolled people" : "No one enrolled"}
                    >
                      {seq._enrollmentCount}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={seq._activeCount! > 0 ? "default" : "secondary"}>
                      {seq._activeCount}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex gap-1">
                      {seq.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePause(seq)}
                          disabled={busyId === seq.id}
                          title="Pause this sequence"
                        >
                          {busyId === seq.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                        </Button>
                      )}
                      {seq.status === "paused" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleResume(seq)}
                          disabled={busyId === seq.id}
                          title="Resume + re-pace from now"
                        >
                          {busyId === seq.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        </Button>
                      )}
                      <Link to={`/sequences/${seq.id}/schedule`}>
                        <Button variant="ghost" size="sm">
                          <Calendar className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Link to={`/sequences/${seq.id}/analytics`}>
                        <Button variant="ghost" size="sm">
                          <BarChart3 className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </>
        )}
        </SectionCard>
      </div>
      <EnrolledPeopleDialog
        sequenceId={drillSequence?.id ?? null}
        sequenceName={drillSequence?.name ?? ""}
        audienceType={drillSequence?.audience_type ?? "candidates"}
        open={!!drillSequence}
        onOpenChange={(o) => { if (!o) setDrillSequence(null); }}
      />
    </>
  );
}
