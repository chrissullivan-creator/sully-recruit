import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

interface FailureGroup {
  sequence_id: string;
  sequence_name: string;
  count: number;
  reasons: Record<string, number>;
}

/**
 * Dead-letter aggregation across every sequence on the tenant. The
 * per-sequence Failed section in SequenceScheduleView only surfaces
 * failures for the sequence the recruiter happens to be looking at.
 * This summary lives under the SequenceList header so a glance at
 * the hub answers "where are sends silently failing right now?"
 *
 * Renders nothing when there are zero failures so it doesn't clutter
 * the list on a healthy day. Retry-all per sequence flips every
 * matching step_log back to status='scheduled' + scheduled_at=now;
 * the sweep + executor revalidate everything (recipient, account
 * health, send window, daily cap) before firing.
 */
export function FailureSummary({ onRetryDone }: { onRetryDone?: () => void }) {
  const [groups, setGroups] = useState<FailureGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [busySeq, setBusySeq] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("sequence_step_logs")
        .select(`
          id, skip_reason,
          sequence_enrollments!inner(
            sequence_id,
            sequences!inner(name)
          )
        `)
        .eq("status", "failed")
        .limit(1000) as any;
      if (error || cancelled) return;

      const byId: Record<string, FailureGroup> = {};
      for (const row of data || []) {
        const seqId = row.sequence_enrollments?.sequence_id;
        const seqName = row.sequence_enrollments?.sequences?.name || "Untitled";
        if (!seqId) continue;
        if (!byId[seqId]) byId[seqId] = { sequence_id: seqId, sequence_name: seqName, count: 0, reasons: {} };
        byId[seqId].count += 1;
        const reason = (row.skip_reason || "unknown").slice(0, 40);
        byId[seqId].reasons[reason] = (byId[seqId].reasons[reason] || 0) + 1;
      }
      setGroups(Object.values(byId).sort((a, b) => b.count - a.count));
    })();
    return () => { cancelled = true; };
  }, []);

  const total = groups.reduce((s, g) => s + g.count, 0);
  if (total === 0) return null;

  const handleRetryGroup = async (group: FailureGroup) => {
    if (!window.confirm(`Retry ${group.count} failed send${group.count === 1 ? "" : "s"} on "${group.sequence_name}"?`)) return;
    setBusySeq(group.sequence_id);
    try {
      // Re-query the failed log ids for this sequence so we don't
      // inadvertently retry rows that have already been retried in
      // another tab since the summary loaded.
      const { data: failedLogs } = await supabase
        .from("sequence_step_logs")
        .select("id, sequence_enrollments!inner(sequence_id)")
        .eq("status", "failed")
        .eq("sequence_enrollments.sequence_id", group.sequence_id) as any;
      const ids = (failedLogs || []).map((r: any) => r.id);
      if (ids.length === 0) {
        toast.message("Nothing left to retry");
        setGroups((prev) => prev.filter((g) => g.sequence_id !== group.sequence_id));
        return;
      }
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("sequence_step_logs")
        .update({ status: "scheduled", scheduled_at: nowIso, skip_reason: null, updated_at: nowIso } as any)
        .in("id", ids);
      if (error) throw error;
      toast.success(`${ids.length} retr${ids.length === 1 ? "y" : "ies"} queued on "${group.sequence_name}"`);
      setGroups((prev) => prev.filter((g) => g.sequence_id !== group.sequence_id));
      onRetryDone?.();
    } catch (err: any) {
      toast.error(err?.message || "Retry failed");
    } finally {
      setBusySeq(null);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border border-amber-300 bg-amber-50/40 px-3 py-2">
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-2 text-amber-900 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" />
              {total} failed send{total === 1 ? "" : "s"} across {groups.length} sequence{groups.length === 1 ? "" : "s"}
            </span>
            <span className="text-amber-900/70">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-1">
          {groups.map((group) => (
            <div
              key={group.sequence_id}
              className="flex items-center justify-between gap-3 rounded border border-amber-200 bg-white px-2 py-1.5 text-xs"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{group.sequence_name}</p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {Object.entries(group.reasons)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([reason, n]) => (
                      <Badge key={reason} variant="outline" className="text-[10px]">
                        {reason}: {n}
                      </Badge>
                    ))}
                </div>
              </div>
              <span className="text-amber-900 font-mono whitespace-nowrap">{group.count}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busySeq === group.sequence_id}
                onClick={() => handleRetryGroup(group)}
              >
                {busySeq === group.sequence_id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <><RotateCcw className="h-3 w-3 mr-1" /> Retry all</>
                )}
              </Button>
            </div>
          ))}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
