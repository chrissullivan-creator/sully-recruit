import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, BarChart3, Calendar, Pause, Play, Loader2, OctagonX, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders } from "@/lib/api-auth";
import { EnrolledPeopleDialog } from "./EnrolledPeopleDialog";
import { DailyUtilization } from "./DailyUtilization";

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
  const [stopTarget, setStopTarget] = useState<SequenceRow | null>(null);
  // Tracks per-row pause/resume mutation state so we can disable
  // the buttons + show a spinner.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Tenant-wide anomaly counts the engine should rarely produce. When
  // they appear, the recruiter wants to see them on the list rather
  // than discover them buried in a per-sequence schedule view.
  const [stuckInFlight, setStuckInFlight] = useState<number>(0);
  const [staleConnections, setStaleConnections] = useState<number>(0);

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

  async function handleStopConfirmed(seq: SequenceRow) {
    setBusyId(seq.id);
    try {
      // stop_sequence RPC bulk-terminates active enrollments and
      // cancels their pending step_logs in one transaction. Matches
      // the engine's existing stop semantics (status='stopped',
      // stop_reason set) so reply-stop and operator-stop are
      // indistinguishable downstream.
      const { data, error } = await (supabase as any).rpc("stop_sequence", {
        p_sequence_id: seq.id,
        p_reason: "manual_stop",
      });
      if (error) throw error;
      // Also flip the sequence status itself so it doesn't keep
      // accepting new enrollments. Pause leaves it resumable; Stop
      // is a terminal mark for the campaign.
      const { error: seqErr } = await supabase
        .from("sequences")
        .update({ status: "stopped", updated_at: new Date().toISOString() } as any)
        .eq("id", seq.id);
      if (seqErr) throw seqErr;
      const row = Array.isArray(data) ? data[0] : data;
      const stopped = row?.stopped_enrollments ?? 0;
      const cancelled = row?.cancelled_step_logs ?? 0;
      toast.success(
        `Stopped ${stopped} enrollment${stopped === 1 ? "" : "s"} — ${cancelled} pending send${cancelled === 1 ? "" : "s"} cancelled`,
      );
      setStopTarget(null);
      await loadSequences();
    } catch (err: any) {
      toast.error(err?.message || "Failed to stop sequence");
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

  useEffect(() => {
    loadSequences();
    loadAnomalies();
  }, []);

  // Counts step_logs that look like the engine got stuck:
  //   - in_flight > 10 minutes (sweep auto-resets these but if the
  //     sweep itself is broken they pile up)
  //   - pending_connection > 14 days (LinkedIn invite never accepted)
  // Both are tenant-wide; SequenceList sits on top of every sequence
  // so it's the right surface to flag them.
  async function loadAnomalies() {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [{ count: stuck }, { count: stale }] = await Promise.all([
      supabase
        .from("sequence_step_logs")
        .select("id", { count: "exact", head: true })
        .eq("status", "in_flight")
        .lt("updated_at", tenMinAgo),
      supabase
        .from("sequence_step_logs")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_connection")
        .lt("scheduled_at", fourteenDaysAgo),
    ]);
    setStuckInFlight(stuck || 0);
    setStaleConnections(stale || 0);
  }

  async function handleResetStuckInFlight() {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("sequence_step_logs")
      .update({ status: "scheduled", updated_at: new Date().toISOString() } as any)
      .eq("status", "in_flight")
      .lt("updated_at", tenMinAgo);
    if (error) {
      toast.error(error.message || "Couldn't reset stuck rows");
      return;
    }
    toast.success("Stuck in-flight rows reset to scheduled");
    setStuckInFlight(0);
  }

  async function loadSequences() {
    try {
      const { data, error } = await supabase
        .from("sequences")
        .select("id, name, audience_type, status, created_at, job_id, jobs(title)")
        .order("created_at", { ascending: false }) as any;

      if (error) throw error;

      // Fetch enrollment counts
      const enriched = await Promise.all(
        (data || []).map(async (seq: SequenceRow) => {
          const { count: totalCount } = await supabase
            .from("sequence_enrollments")
            .select("id", { count: "exact", head: true })
            .eq("sequence_id", seq.id);

          const { count: activeCount } = await supabase
            .from("sequence_enrollments")
            .select("id", { count: "exact", head: true })
            .eq("sequence_id", seq.id)
            .eq("status", "active");

          return { ...seq, _enrollmentCount: totalCount || 0, _activeCount: activeCount || 0 };
        }),
      );
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
        <div className="mb-4">
          <p className="text-[10px] font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Today's send utilization
          </p>
          <DailyUtilization />
        </div>
        {(stuckInFlight > 0 || staleConnections > 0) && (
          <div className="mb-4 space-y-1.5">
            {stuckInFlight > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
                <span className="inline-flex items-center gap-2 text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {stuckInFlight} step log{stuckInFlight === 1 ? "" : "s"} stuck in <code className="font-mono">in_flight</code> &gt; 10 min
                </span>
                <Button variant="outline" size="sm" onClick={handleResetStuckInFlight} className="h-7 text-xs">
                  Reset
                </Button>
              </div>
            )}
            {staleConnections > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
                <span className="inline-flex items-center gap-2 text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {staleConnections} LinkedIn invite{staleConnections === 1 ? "" : "s"} pending acceptance &gt; 14 days
                </span>
                <span className="text-[10px] text-amber-900/70 italic">
                  cleaned by sequence-pending-connection-timeout daily
                </span>
              </div>
            )}
          </div>
        )}
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
          <Table>
            <TableHeader>
              <TableRow>
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
                <TableRow key={seq.id}>
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
                      {(seq.status === "active" || seq.status === "paused") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setStopTarget(seq)}
                          disabled={busyId === seq.id}
                          title="Stop campaign — cancels pending sends and ends all active enrollments"
                          className="text-destructive hover:text-destructive"
                        >
                          <OctagonX className="h-4 w-4" />
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
        )}
      </CardContent>
      <EnrolledPeopleDialog
        sequenceId={drillSequence?.id ?? null}
        sequenceName={drillSequence?.name ?? ""}
        audienceType={drillSequence?.audience_type ?? "candidates"}
        open={!!drillSequence}
        onOpenChange={(o) => { if (!o) setDrillSequence(null); }}
      />
      <AlertDialog open={!!stopTarget} onOpenChange={(o) => { if (!o) setStopTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop "{stopTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This terminates the campaign:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li><strong>{stopTarget?._activeCount ?? 0}</strong> active enrollment{(stopTarget?._activeCount ?? 0) === 1 ? "" : "s"} will be marked <span className="font-mono">stopped</span></li>
                  <li>All pending sends (scheduled + waiting-for-connection) will be cancelled</li>
                  <li>Sent history is preserved for analytics</li>
                  <li>The sequence won't accept new enrollments</li>
                </ul>
                <p className="text-muted-foreground italic pt-1">
                  This can't be undone. Use Pause if you only want to halt sends temporarily.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId === stopTarget?.id}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (stopTarget) handleStopConfirmed(stopTarget);
              }}
              disabled={busyId === stopTarget?.id}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyId === stopTarget?.id ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <OctagonX className="h-4 w-4 mr-2" />}
              Stop sequence
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
