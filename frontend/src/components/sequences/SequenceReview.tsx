import { useMemo } from "react";
import { SectionCard } from "@/components/shared/SectionCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Save, Rocket, Mail, Linkedin, MessageSquare, Phone, UserPlus, ClipboardCheck } from "lucide-react";
import { tzLabel, type SequenceSetupData } from "./SequenceSetup";
import type { SequenceBranch } from "./FlowBuilder";
import { getBranchStats, flattenBranchSteps } from "./sequenceBranches";

// Channel → icon + label for the step timeline.
function channelIcon(ch: string) {
  if (ch === "email") return <Mail className="h-3 w-3" />;
  if (ch === "linkedin_connect") return <UserPlus className="h-3 w-3" />;
  if (ch?.startsWith("linkedin")) return <Linkedin className="h-3 w-3" />;
  if (ch === "sms") return <MessageSquare className="h-3 w-3" />;
  if (ch === "phone" || ch === "call") return <Phone className="h-3 w-3" />;
  return <Mail className="h-3 w-3" />;
}
function channelLabel(ch: string) {
  if (ch === "linkedin_connect") return "LinkedIn connect";
  if (ch?.startsWith("linkedin")) return "LinkedIn";
  return ch;
}
import { useChannelLimits } from "@/hooks/useData";

interface Props {
  setup: SequenceSetupData;
  branches: SequenceBranch[];
  enrollmentCount?: number;
  onSaveDraft: () => void;
  onActivate: () => void;
  saving?: boolean;
}

export function SequenceReview({ setup, branches, enrollmentCount = 0, onSaveDraft, onActivate, saving }: Props) {
  const { data: channelLimits } = useChannelLimits();
  // Daily cap per channel, read from the same channel_limits table the engine
  // enforces (editable under Settings → Send Limits). Missing/blank = no cap.
  const dailyCap = (channel: string): number => channelLimits?.[channel]?.daily_max ?? Infinity;

  const stats = useMemo(() => {
    return getBranchStats(branches);
  }, [branches]);

  // Linear list of steps (single-lane; legacy branch_b is folded into branch_a).
  const steps = useMemo(() => flattenBranchSteps(branches), [branches]);

  const warnings = useMemo(() => {
    const warns: string[] = [];
    if (!setup.name) warns.push("Sequence name is required");
    if (!setup.senderUserId) warns.push("Select a sender (Send As) in Setup");
    if (stats.totalActions === 0) warns.push("Add at least one action step in the Builder");

    // Check if day-1 sends would exceed caps
    if (enrollmentCount > 0) {
      for (const [channel, count] of Object.entries(stats.channelCounts)) {
        const dailyMax = dailyCap(channel);
        const day1Sends = count * enrollmentCount;
        if (day1Sends > dailyMax) {
          warns.push(
            `${channel}: ${day1Sends} sends on day 1 exceeds daily cap of ${dailyMax}. Suggested: enroll ${Math.floor(dailyMax / count)} people per day.`,
          );
        }
      }
    }

    return warns;
  }, [setup, stats, enrollmentCount, channelLimits]);

  const suggestedSpread = useMemo(() => {
    if (enrollmentCount === 0) return null;
    let minPerDay = Infinity;
    for (const [channel, count] of Object.entries(stats.channelCounts)) {
      const dailyMax = dailyCap(channel);
      const perDay = Math.floor(dailyMax / Math.max(count, 1));
      if (perDay < minPerDay) minPerDay = perDay;
    }
    return minPerDay === Infinity ? null : minPerDay;
  }, [stats, enrollmentCount, channelLimits]);

  return (
    <SectionCard title="Review & Activate" icon={<ClipboardCheck className="h-4 w-4" />}>
      <div className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-card-border bg-page-bg/50 p-4">
          {[
            { label: "Name", value: setup.name || "Untitled" },
            { label: "Audience", value: setup.audienceType, capitalize: true },
            { label: "Send Window", value: `${setup.sendWindowStart} – ${setup.sendWindowEnd} ${tzLabel(setup.timezone || "America/New_York")}` },
            { label: "Total Actions", value: stats.totalActions },
            { label: "Steps", value: steps.length },
          ].map((row) => (
            <div key={row.label}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{row.label}</p>
              <p className={`font-medium text-foreground ${row.capitalize ? "capitalize" : ""}`}>{row.value}</p>
            </div>
          ))}
        </div>

        {/* Step timeline — when each step sends + on which channel(s) */}
        {steps.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Step timeline</p>
            <ol className="space-y-2.5 border-l border-border pl-4">
              {(() => {
                let cumHours = 0;
                return steps.map((step, i) => {
                  cumHours += step.actions?.[0]?.baseDelayHours ?? 0;
                  const day = Math.max(1, Math.round(cumHours / 24) + 1);
                  return (
                    <li key={step.id} className="relative">
                      <span className="absolute -left-[1.32rem] top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-semibold text-foreground">Step {i + 1}</span>
                        <span className="text-xs text-muted-foreground">· Day {day}</span>
                        {(step.actions || []).map((a, j) => (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] capitalize text-foreground"
                          >
                            {channelIcon(a.channel)} {channelLabel(a.channel)}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                });
              })()}
            </ol>
          </div>
        )}

        {/* Channel breakdown */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Estimated daily sends per channel</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.channelCounts).map(([channel, count]) => (
              <Badge key={channel} variant="secondary">
                {channel}: {enrollmentCount > 0 ? `${count * enrollmentCount}/${dailyCap(channel) === Infinity ? "∞" : dailyCap(channel)}` : `${count} per person`}
              </Badge>
            ))}
          </div>
        </div>

        {/* Suggested spread */}
        {suggestedSpread && enrollmentCount > suggestedSpread && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Suggested: enroll {suggestedSpread} people per day to stay within channel caps.
            </AlertDescription>
          </Alert>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-2">
            {warnings.map((w, i) => (
              <Alert key={i} variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-2">
          <Button variant="outline" onClick={onSaveDraft} disabled={saving} className="flex-1">
            <Save className="h-4 w-4 mr-2" />
            Save Draft
          </Button>
          <Button onClick={onActivate} disabled={saving || warnings.some((w) => w.includes("required"))} className="flex-1">
            <Rocket className="h-4 w-4 mr-2" />
            Activate
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
