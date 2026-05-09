import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, SkipForward, Calendar, AlertTriangle, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";

const CHANNEL_COLORS: Record<string, string> = {
  linkedin_connection: "bg-blue-200 text-blue-900",
  linkedin_message: "bg-blue-100 text-blue-800",
  linkedin_inmail: "bg-indigo-100 text-indigo-800",
  email: "bg-green-100 text-green-800",
  sms: "bg-yellow-100 text-yellow-800",
  manual_call: "bg-orange-100 text-orange-800",
};

const CHANNEL_DAILY_MAX: Record<string, number> = {
  linkedin_connection: 35,
  linkedin_message: 40,
  email: 150,
};

interface ScheduledSend {
  id: string;
  enrollment_id: string;
  channel: string;
  scheduled_at: string;
  status: string;
  entityName: string;
  entityId: string;
  entityType: string;
}

interface FailedSend extends ScheduledSend {
  skip_reason?: string | null;
}

export default function SequenceScheduleView() {
  const { id } = useParams();
  const [sequence, setSequence] = useState<any>(null);
  const [sends, setSends] = useState<ScheduledSend[]>([]);
  const [failed, setFailed] = useState<FailedSend[]>([]);
  const [dailyCounts, setDailyCounts] = useState<Record<string, number>>({});
  const [view, setView] = useState<"day" | "week">("week");
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  async function loadData() {
    try {
      // Load sequence
      const { data: seq, error: seqError } = await supabase
        .from("sequences")
        .select("*")
        .eq("id", id)
        .single() as any;
      if (seqError) throw seqError;
      setSequence(seq);

      // Load scheduled + sent + failed step logs with enrollment
      // details. Failed rows feed the dedicated "Failed (N)" section so
      // the recruiter can retry them without dropping into the DB.
      const { data: logs, error: logsError } = await supabase
        .from("sequence_step_logs")
        .select(`
          id, enrollment_id, channel, scheduled_at, status, skip_reason,
          sequence_enrollments!inner(
            candidate_id, contact_id,
            candidate:people!candidate_id(first_name, last_name),
            contact:people!contact_id(first_name, last_name)
          )
        `)
        .eq("sequence_enrollments.sequence_id", id)
        .in("status", ["scheduled", "sent", "failed"])
        .order("scheduled_at", { ascending: true }) as any;
      if (logsError) throw logsError;

      const mapped: FailedSend[] = (logs || []).map((log: any) => {
        const enrollment = log.sequence_enrollments;
        const candidate = enrollment?.candidate ?? enrollment?.candidates;
        const contact = enrollment?.contact ?? enrollment?.contacts;
        const name = candidate
          ? `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim()
          : contact
            ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
            : "Unknown";

        return {
          id: log.id,
          enrollment_id: log.enrollment_id,
          channel: log.channel,
          scheduled_at: log.scheduled_at,
          status: log.status,
          skip_reason: log.skip_reason,
          entityName: name,
          entityId: enrollment?.candidate_id || enrollment?.contact_id,
          entityType: enrollment?.candidate_id ? "candidate" : "contact",
        };
      });
      setSends(mapped.filter((s) => s.status !== "failed"));
      setFailed(mapped.filter((s) => s.status === "failed"));

      // Load daily send counts
      const { data: dailyLogs, error: dailyError } = await supabase
        .from("daily_send_log")
        .select("channel, send_date, count")
        .order("send_date", { ascending: false })
        .limit(100) as any;
      if (dailyError) throw dailyError;

      const counts: Record<string, number> = {};
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      for (const log of dailyLogs || []) {
        if (log.send_date === today) {
          counts[log.channel] = (counts[log.channel] || 0) + log.count;
        }
      }
      setDailyCounts(counts);
    } catch (err: any) {
      console.error("Failed to load sequence schedule:", err);
      toast.error(err?.message || "Failed to load sequence schedule");
    } finally {
      setLoading(false);
    }
  }

  // Group sends by day
  const sendsByDay = useMemo(() => {
    const grouped: Record<string, ScheduledSend[]> = {};
    for (const send of sends) {
      const date = new Date(send.scheduled_at).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(send);
    }
    return grouped;
  }, [sends]);

  const formatEST = (iso: string) => {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  // Retry a single failed step_log by flipping it back to 'scheduled'
  // with scheduled_at = now. Sweep picks it up on the next 3-min tick.
  // We don't pre-flight-check the recipient or send window — the
  // sweep + executor revalidate everything (recipient, account health,
  // send window, daily cap) before firing.
  const handleRetryOne = async (logId: string, atMs: number = Date.now()) => {
    setRetrying(logId);
    try {
      const { error } = await supabase
        .from("sequence_step_logs")
        .update({
          status: "scheduled",
          scheduled_at: new Date(atMs).toISOString(),
          skip_reason: null,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", logId);
      if (error) throw error;
      const moved = failed.find((s) => s.id === logId);
      setFailed((prev) => prev.filter((s) => s.id !== logId));
      if (moved) setSends((prev) => [...prev, { ...moved, status: "scheduled" }]);
      toast.success("Retry queued");
    } catch (err: any) {
      toast.error(err?.message || "Retry failed");
    } finally {
      setRetrying(null);
    }
  };

  const handleRetryAll = async () => {
    if (failed.length === 0) return;
    if (!window.confirm(`Retry all ${failed.length} failed send${failed.length === 1 ? "" : "s"}? They'll fire on the next sweep tick.`)) return;
    const nowIso = new Date().toISOString();
    const ids = failed.map((s) => s.id);
    const { error } = await supabase
      .from("sequence_step_logs")
      .update({ status: "scheduled", scheduled_at: nowIso, skip_reason: null, updated_at: nowIso } as any)
      .in("id", ids);
    if (error) {
      toast.error(error.message || "Retry failed");
      return;
    }
    setSends((prev) => [...prev, ...failed.map((s) => ({ ...s, status: "scheduled" }))]);
    setFailed([]);
    toast.success(`${ids.length} retr${ids.length === 1 ? "y" : "ies"} queued`);
  };

  const handleSkipSend = async (logId: string) => {
    const skipped = sends.find((s) => s.id === logId);
    const { error } = await supabase
      .from("sequence_step_logs")
      .update({ status: "skipped" } as any)
      .eq("id", logId);
    if (error) {
      toast.error(error.message || "Failed to skip send");
      return;
    }
    setSends((prev) => prev.filter((s) => s.id !== logId));
    // Surface an Undo affordance — recruiters click Skip by mistake on
    // queue rows and previously had no way back without DB access. The
    // RPC only restores rows whose scheduled_at is still in the future,
    // so an undo arriving after the original send window passes will
    // no-op (and we surface that case instead of silently failing).
    toast.success("Send skipped", {
      action: {
        label: "Undo",
        onClick: async () => {
          const { data, error: rpcErr } = await (supabase as any).rpc("restore_skipped_step", {
            p_step_log_id: logId,
          });
          if (rpcErr) {
            toast.error(rpcErr.message || "Couldn't undo skip");
            return;
          }
          const restored = typeof data === "number" ? data : Number(data ?? 0);
          if (restored > 0 && skipped) {
            setSends((prev) => [...prev, skipped]);
            toast.success("Skip undone — send restored");
          } else {
            toast.message("Too late to restore — its send window already passed");
          }
        },
      },
      duration: 10_000,
    });
  };

  if (loading) return <MainLayout><div className="container mx-auto py-6">Loading...</div></MainLayout>;

  return (
    <MainLayout>
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/sequences/${id}/edit`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{sequence?.name} — Schedule</h1>
      </div>

      {/* Channel utilization bars */}
      <div className="grid grid-cols-3 gap-4">
        {Object.entries(CHANNEL_DAILY_MAX).map(([channel, max]) => {
          const current = dailyCounts[channel] || 0;
          const pct = Math.min((current / max) * 100, 100);
          return (
            <Card key={channel}>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium capitalize">{channel.replace(/_/g, " ")}</span>
                  <span className="text-sm text-muted-foreground">{current}/{max}</span>
                </div>
                <Progress value={pct} className="h-2" />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {failed.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardHeader className="py-3 flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              Failed ({failed.length})
            </CardTitle>
            <Button variant="outline" size="sm" onClick={handleRetryAll} className="h-7 text-xs">
              <RotateCcw className="h-3 w-3 mr-1" /> Retry all
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failed.map((send) => (
                  <TableRow key={send.id}>
                    <TableCell>
                      <Link
                        to={`/${send.entityType === "candidate" ? "candidates" : "contacts"}/${send.entityId}`}
                        className="hover:underline text-sm"
                      >
                        {send.entityName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge className={CHANNEL_COLORS[send.channel] || "bg-gray-100"}>
                        {send.channel.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-md truncate" title={send.skip_reason || ""}>
                      {send.skip_reason || "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRetryOne(send.id)}
                        disabled={retrying === send.id}
                        title="Retry this send now"
                        className="h-7 text-xs"
                      >
                        {retrying === send.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><RotateCcw className="h-3 w-3 mr-1" /> Retry</>}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* View toggle */}
      <Tabs value={view} onValueChange={(v) => setView(v as "day" | "week")}>
        <TabsList>
          <TabsTrigger value="day">Day</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Schedule grid */}
      {Object.keys(sendsByDay).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No scheduled sends. Enroll people into this sequence to see their schedule.
          </CardContent>
        </Card>
      ) : (
        Object.entries(sendsByDay)
          .slice(0, view === "day" ? 1 : 7)
          .map(([date, daySends]) => (
            <Card key={date}>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  {date} — {daySends.length} sends
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time (EST)</TableHead>
                      <TableHead>Person</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {daySends
                      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
                      .map((send) => (
                        <TableRow key={send.id}>
                          <TableCell className="text-sm">{formatEST(send.scheduled_at)}</TableCell>
                          <TableCell>
                            <Link
                              to={`/${send.entityType === "candidate" ? "candidates" : "contacts"}/${send.entityId}`}
                              className="hover:underline text-sm"
                            >
                              {send.entityName}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge className={CHANNEL_COLORS[send.channel] || "bg-gray-100"}>
                              {send.channel.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={send.status === "sent" ? "default" : "outline"}>
                              {send.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {send.status === "scheduled" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleSkipSend(send.id)}
                                title="Skip this send (you can undo for 10 seconds)"
                              >
                                <SkipForward className="h-3 w-3" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))
      )}
    </div>
    </MainLayout>
  );
}
