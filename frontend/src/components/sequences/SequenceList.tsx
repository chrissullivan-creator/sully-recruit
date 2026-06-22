import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, BarChart3, Calendar, Pause, Play, Loader2, Archive, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/api-auth";
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
      const verb = status === "active" ? "activated" : status === "paused" ? "paused" : "archived";
      toast.success(`${selectedIds.length} sequence${selectedIds.length === 1 ? "" : "s"} ${verb}`);
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Sequences</CardTitle>
        <Link to="/sequences/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" /> New Sequence
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : sequences.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>No sequences yet.</p>
            <Link to="/sequences/new">
              <Button variant="outline" className="mt-4">
                <Plus className="h-4 w-4 mr-2" /> Create Your First Sequence
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {selectedIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
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
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Enrolled</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((seq) => (
                <TableRow key={seq.id} className={selectedIds.includes(seq.id) ? "bg-accent/5" : undefined}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.includes(seq.id)}
                      onCheckedChange={() => toggleSelect(seq.id)}
                      aria-label={`Select ${seq.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link to={`/sequences/${seq.id}/edit`} className="hover:underline">
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
                  <TableCell>
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
      </CardContent>
      <EnrolledPeopleDialog
        sequenceId={drillSequence?.id ?? null}
        sequenceName={drillSequence?.name ?? ""}
        audienceType={drillSequence?.audience_type ?? "candidates"}
        open={!!drillSequence}
        onOpenChange={(o) => { if (!o) setDrillSequence(null); }}
      />
    </Card>
  );
}
