import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, Mail, MessageSquare, Linkedin, CheckCircle2, XCircle, PauseCircle, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

/**
 * Enrolled-people drill-in for a sequence row.
 *
 * The Sequences list shows just the count; this dialog answers "who
 * are they?" — name, type (candidate/contact), enrolled timestamp,
 * status (active/stopped/completed/paused), reply received indicator,
 * step counts (sent / scheduled / pending_connection). Each row
 * navigates to the person's detail page so the recruiter can drop into
 * the same conversation surface they're used to.
 */

interface EnrollmentRow {
  id: string;
  candidate_id: string | null;
  contact_id: string | null;
  status: string;
  enrolled_at: string;
  reply_received_at: string | null;
  reply_sentiment: string | null;
  stopped_reason: string | null;
}

interface PersonRow {
  id: string;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
}

interface StepCount {
  enrollment_id: string;
  sent: number;
  scheduled: number;
  pending_connection: number;
  failed: number;
  skipped: number;
}

function statusBadge(status: string, replyReceived: boolean) {
  if (replyReceived) {
    return <Badge variant="outline" className="border-emerald/40 text-emerald-dark text-[10px]">↩ Replied</Badge>;
  }
  const map: Record<string, { label: string; cls: string; Icon: any }> = {
    active: { label: "Active", cls: "border-emerald/40 text-emerald-dark", Icon: Clock },
    stopped: { label: "Stopped", cls: "border-muted-foreground/30 text-muted-foreground", Icon: XCircle },
    completed: { label: "Completed", cls: "border-blue-300 text-blue-700", Icon: CheckCircle2 },
    paused: { label: "Paused", cls: "border-yellow-300 text-yellow-700", Icon: PauseCircle },
  };
  const cfg = map[status] ?? { label: status, cls: "border-muted-foreground/30 text-muted-foreground", Icon: Clock };
  const Icon = cfg.Icon;
  return (
    <Badge variant="outline" className={cn("text-[10px] gap-1", cfg.cls)}>
      <Icon className="h-3 w-3" /> {cfg.label}
    </Badge>
  );
}

export function EnrolledPeopleDialog({
  sequenceId,
  sequenceName,
  audienceType,
  open,
  onOpenChange,
}: {
  sequenceId: string | null;
  sequenceName: string;
  audienceType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["sequence_enrollments_drill", sequenceId],
    enabled: !!sequenceId && open,
    queryFn: async (): Promise<{ enrollments: EnrollmentRow[]; people: Map<string, PersonRow>; steps: Map<string, StepCount> }> => {
      const { data: enrollments } = await supabase
        .from("sequence_enrollments")
        .select("id, candidate_id, contact_id, status, enrolled_at, reply_received_at, reply_sentiment, stopped_reason")
        .eq("sequence_id", sequenceId!)
        .order("enrolled_at", { ascending: false });

      const list = (enrollments ?? []) as EnrollmentRow[];
      const candIds = list.filter((e) => e.candidate_id).map((e) => e.candidate_id!) as string[];
      const contIds = list.filter((e) => e.contact_id).map((e) => e.contact_id!) as string[];

      const peopleMap = new Map<string, PersonRow>();
      if (candIds.length) {
        const { data: cands } = await supabase
          .from("people")
          .select("id, full_name, email, current_title, current_company")
          .in("id", candIds);
        for (const p of (cands ?? []) as PersonRow[]) peopleMap.set(p.id, p);
      }
      if (contIds.length) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, full_name, email, current_title, current_company")
          .in("id", contIds);
        for (const p of (contacts ?? []) as PersonRow[]) peopleMap.set(p.id, p);
      }

      // Step counts per enrollment, in one round trip.
      const stepsMap = new Map<string, StepCount>();
      const enrollmentIds = list.map((e) => e.id);
      if (enrollmentIds.length) {
        const { data: stepLogs } = await supabase
          .from("sequence_step_logs")
          .select("enrollment_id, status")
          .in("enrollment_id", enrollmentIds);
        for (const id of enrollmentIds) {
          stepsMap.set(id, { enrollment_id: id, sent: 0, scheduled: 0, pending_connection: 0, failed: 0, skipped: 0 });
        }
        for (const log of (stepLogs ?? []) as any[]) {
          const e = stepsMap.get(log.enrollment_id);
          if (!e) continue;
          if (log.status === "sent") e.sent++;
          else if (log.status === "scheduled") e.scheduled++;
          else if (log.status === "pending_connection") e.pending_connection++;
          else if (log.status === "failed") e.failed++;
          else if (log.status === "skipped") e.skipped++;
        }
      }

      return { enrollments: list, people: peopleMap, steps: stepsMap };
    },
    staleTime: 30_000,
  });

  const counts = useMemo(() => {
    const list = data?.enrollments ?? [];
    return {
      total: list.length,
      active: list.filter((e) => e.status === "active").length,
      replied: list.filter((e) => e.reply_received_at).length,
      stopped: list.filter((e) => e.status === "stopped").length,
      completed: list.filter((e) => e.status === "completed").length,
    };
  }, [data?.enrollments]);

  const goToPerson = (e: EnrollmentRow) => {
    onOpenChange(false);
    if (e.candidate_id) navigate(`/candidates/${e.candidate_id}`);
    else if (e.contact_id) navigate(`/contacts/${e.contact_id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{sequenceName} — Enrolled</DialogTitle>
          <DialogDescription className="flex flex-wrap gap-3 text-xs pt-1">
            <span><strong>{counts.total}</strong> total</span>
            <span className="text-emerald-dark"><strong>{counts.active}</strong> active</span>
            <span className="text-muted-foreground"><strong>{counts.replied}</strong> replied</span>
            <span className="text-muted-foreground"><strong>{counts.stopped}</strong> stopped</span>
            <span className="text-muted-foreground"><strong>{counts.completed}</strong> completed</span>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">Loading…</p>
          ) : (data?.enrollments ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">No one enrolled yet.</p>
          ) : (
            <div className="space-y-1.5">
              {data!.enrollments.map((e) => {
                const p = e.candidate_id
                  ? data!.people.get(e.candidate_id)
                  : e.contact_id ? data!.people.get(e.contact_id) : null;
                const steps = data!.steps.get(e.id);
                const enrolledDate = e.enrolled_at ? format(parseISO(e.enrolled_at), "MMM d, yyyy") : "";
                return (
                  <button
                    key={e.id}
                    onClick={() => goToPerson(e)}
                    className="w-full text-left rounded-md border border-card-border bg-white px-3 py-2 hover:border-emerald/40 hover:bg-emerald-light/10 transition-colors group flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{p?.full_name || p?.email || "Unknown"}</span>
                        <Badge variant="outline" className="text-[9px] capitalize">
                          {e.candidate_id ? "candidate" : "contact"}
                        </Badge>
                        {statusBadge(e.status, !!e.reply_received_at)}
                        {e.stopped_reason && (
                          <span className="text-[10px] text-muted-foreground italic">· {e.stopped_reason}</span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {[p?.current_title, p?.current_company].filter(Boolean).join(" · ") || p?.email || ""}
                      </div>
                      <div className="flex items-center gap-2.5 mt-1 text-[10px] text-muted-foreground/80">
                        <span>Enrolled {enrolledDate}</span>
                        {steps && (
                          <>
                            <span className="text-emerald-dark">{steps.sent} sent</span>
                            {steps.scheduled > 0 && <span>{steps.scheduled} queued</span>}
                            {steps.pending_connection > 0 && (
                              <span className="text-blue-700"><Linkedin className="h-2.5 w-2.5 inline" /> {steps.pending_connection} awaiting connection</span>
                            )}
                            {steps.skipped > 0 && <span>{steps.skipped} skipped</span>}
                            {steps.failed > 0 && <span className="text-destructive">{steps.failed} failed</span>}
                          </>
                        )}
                      </div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-emerald-dark shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex justify-end gap-2 pt-2 border-t border-card-border">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Suppress unused-import warning for icons that may not always render
// (Mail/MessageSquare reserved for future per-channel breakdown).
void Mail; void MessageSquare;
