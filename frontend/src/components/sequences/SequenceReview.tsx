import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Save, Rocket } from "lucide-react";
import { tzLabel, type SequenceSetupData } from "./SequenceSetup";
import type { SequenceBranch } from "./FlowBuilder";
import { getBranchStats, getBranchLabel } from "./sequenceBranches";
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
    <Card>
      <CardHeader>
        <CardTitle>Review & Activate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Name:</span>
            <p className="font-medium">{setup.name || "Untitled"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Audience:</span>
            <p className="font-medium capitalize">{setup.audienceType}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Send Window:</span>
            <p className="font-medium">{setup.sendWindowStart} - {setup.sendWindowEnd} {tzLabel(setup.timezone || "America/New_York")}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Total Actions:</span>
            <p className="font-medium">{stats.totalActions}</p>
          </div>
          <div>
            <span className="text-muted-foreground">{getBranchLabel("branch_a")}:</span>
            <p className="font-medium">{stats.actionsPerBranch.branch_a} actions</p>
          </div>
          <div>
            <span className="text-muted-foreground">{getBranchLabel("branch_b")}:</span>
            <p className="font-medium">{stats.actionsPerBranch.branch_b} actions</p>
          </div>
        </div>

        {/* Channel breakdown */}
        <div>
          <p className="text-sm text-muted-foreground mb-2">Estimated daily sends per channel:</p>
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
      </CardContent>
    </Card>
  );
}
