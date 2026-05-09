import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink, AlertTriangle, Loader2, RotateCcw, SkipForward } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const CHANNEL_COLORS: Record<string, string> = {
  linkedin_connection: "bg-blue-200 text-blue-900",
  linkedin_message: "bg-blue-100 text-blue-800",
  linkedin_inmail: "bg-indigo-100 text-indigo-800",
  email: "bg-green-100 text-green-800",
  sms: "bg-yellow-100 text-yellow-800",
  manual_call: "bg-orange-100 text-orange-800",
};

interface QueuedSend {
  id: string;
  channel: string;
  scheduled_at: string;
  status: string;
  skip_reason: string | null;
  entityName: string;
  entityId: string;
  entityType: "candidate" | "contact";
}

interface Props {
  sequenceId: string | null;
  sequenceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Quick-peek schedule drawer for a single sequence — opens from the
 * SequenceList row without leaving the list. Surfaces just the next
 * 24h of scheduled sends + any failed sends that need a retry. The
 * full SequenceScheduleView page remains available via "Open full
 * schedule" for week-over-week planning.
 */
export function SequenceScheduleDrawer({ sequenceId, sequenceName, open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [scheduled, setScheduled] = useState<QueuedSend[]>([]);
  const [failed, setFailed] = useState<QueuedSend[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sequenceId) return;
    setLoading(true);
    (async () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("sequence_step_logs")
        .select(`
          id, channel, scheduled_at, status, skip_reason,
          sequence_enrollments!inner(
            candidate_id, contact_id,
            candidate:people!candidate_id(first_name, last_name),
            contact:people!contact_id(first_name, last_name)
          )
        `)
        .eq("sequence_enrollments.sequence_id", sequenceId)
        .in("status", ["scheduled", "failed"])
        .lte("scheduled_at", tomorrow)
        .order("scheduled_at", { ascending: true })
        .limit(100) as any;
      if (error) {
        toast.error(error.message || "Couldn't load schedule");
        setLoading(false);
        return;
      }
      const mapped: QueuedSend[] = (data || []).map((log: any) => {
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
          channel: log.channel,
          scheduled_at: log.scheduled_at,
          status: log.status,
          skip_reason: log.skip_reason,
          entityName: name || "Unknown",
          entityId: enrollment?.candidate_id || enrollment?.contact_id,
          entityType: enrollment?.candidate_id ? "candidate" : "contact",
        };
      });
      setScheduled(mapped.filter((m) => m.status === "scheduled"));
      setFailed(mapped.filter((m) => m.status === "failed"));
      setLoading(false);
    })();
  }, [open, sequenceId]);

  const handleSkip = async (logId: string) => {
    setBusy(logId);
    const { error } = await supabase
      .from("sequence_step_logs")
      .update({ status: "skipped" } as any)
      .eq("id", logId);
    setBusy(null);
    if (error) {
      toast.error(error.message || "Couldn't skip");
      return;
    }
    setScheduled((prev) => prev.filter((s) => s.id !== logId));
    toast.success("Send skipped");
  };

  const handleRetry = async (logId: string) => {
    setBusy(logId);
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("sequence_step_logs")
      .update({ status: "scheduled", scheduled_at: nowIso, skip_reason: null, updated_at: nowIso } as any)
      .eq("id", logId);
    setBusy(null);
    if (error) {
      toast.error(error.message || "Retry failed");
      return;
    }
    const moved = failed.find((s) => s.id === logId);
    setFailed((prev) => prev.filter((s) => s.id !== logId));
    if (moved) setScheduled((prev) => [...prev, { ...moved, status: "scheduled" }]);
    toast.success("Retry queued");
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{sequenceName} — Next 24h</SheetTitle>
          <SheetDescription>
            Quick peek at the next day of sends. For full week-over-week view, open the schedule page.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {failed.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50/40 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
                    <AlertTriangle className="h-4 w-4" />
                    Failed ({failed.length})
                  </div>
                  <Table>
                    <TableBody>
                      {failed.map((send) => (
                        <TableRow key={send.id}>
                          <TableCell className="text-sm">{send.entityName}</TableCell>
                          <TableCell>
                            <Badge className={CHANNEL_COLORS[send.channel] || "bg-gray-100"}>
                              {send.channel.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate" title={send.skip_reason || ""}>
                            {send.skip_reason || "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRetry(send.id)}
                              disabled={busy === send.id}
                              className="h-7 text-xs"
                            >
                              {busy === send.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><RotateCcw className="h-3 w-3 mr-1" /> Retry</>}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {scheduled.length === 0 && failed.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No sends queued in the next 24h.
                </p>
              ) : (
                scheduled.length > 0 && (
                  <div>
                    <p className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Scheduled ({scheduled.length})
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Person</TableHead>
                          <TableHead>Channel</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {scheduled.map((send) => (
                          <TableRow key={send.id}>
                            <TableCell className="text-xs whitespace-nowrap">{fmt(send.scheduled_at)}</TableCell>
                            <TableCell>
                              <Link
                                to={`/${send.entityType === "candidate" ? "candidates" : "contacts"}/${send.entityId}`}
                                className="text-sm hover:underline"
                                onClick={() => onOpenChange(false)}
                              >
                                {send.entityName}
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Badge className={CHANNEL_COLORS[send.channel] || "bg-gray-100"}>
                                {send.channel.replace(/_/g, " ")}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleSkip(send.id)}
                                disabled={busy === send.id}
                                title="Skip this send"
                                className="h-7"
                              >
                                <SkipForward className="h-3 w-3" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )
              )}

              <div className="pt-2 border-t border-card-border">
                <Link to={sequenceId ? `/sequences/${sequenceId}/schedule` : "#"} onClick={() => onOpenChange(false)}>
                  <Button variant="outline" size="sm" className="w-full text-xs">
                    <ExternalLink className="h-3 w-3 mr-1.5" /> Open full schedule (week view + utilization)
                  </Button>
                </Link>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
