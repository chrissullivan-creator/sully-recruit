import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useChannelLimits } from "@/hooks/useData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, MessageSquare, Linkedin, Loader2, Save } from "lucide-react";

/**
 * Editor for the per-channel daily/hourly send caps stored in `channel_limits`.
 * These are the exact limits the sequence engine enforces
 * (send-time-calculator.ts), so editing them here changes pacing everywhere —
 * the builder's "estimated daily sends" warnings and the schedule view's
 * utilization bars both read the same table via useChannelLimits().
 */
const CHANNELS: { channel: string; label: string; icon: typeof Mail; hint: string }[] = [
  { channel: "email", label: "Email", icon: Mail, hint: "Outlook / Graph sends" },
  { channel: "sms", label: "SMS", icon: MessageSquare, hint: "RingCentral texts" },
  { channel: "linkedin_connection", label: "LinkedIn Connection", icon: Linkedin, hint: "Invites — fire 24/7" },
  { channel: "linkedin_message", label: "LinkedIn Message", icon: Linkedin, hint: "Classic DMs" },
  { channel: "linkedin_inmail", label: "LinkedIn InMail", icon: Linkedin, hint: "Recruiter InMail" },
];

type Draft = Record<string, { daily_max: string; hourly_max: string }>;

export function ChannelLimitsSettings() {
  const { data: limits, isLoading } = useChannelLimits();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);

  // Seed the editable draft from the loaded limits once they arrive.
  useEffect(() => {
    if (!limits) return;
    const next: Draft = {};
    for (const { channel } of CHANNELS) {
      next[channel] = {
        daily_max: limits[channel]?.daily_max != null ? String(limits[channel]!.daily_max) : "",
        hourly_max: limits[channel]?.hourly_max != null ? String(limits[channel]!.hourly_max) : "",
      };
    }
    setDraft(next);
  }, [limits]);

  const dirty = useMemo(() => {
    if (!limits) return false;
    return CHANNELS.some(({ channel }) => {
      const d = draft[channel];
      if (!d) return false;
      const curDaily = limits[channel]?.daily_max != null ? String(limits[channel]!.daily_max) : "";
      const curHourly = limits[channel]?.hourly_max != null ? String(limits[channel]!.hourly_max) : "";
      return d.daily_max !== curDaily || d.hourly_max !== curHourly;
    });
  }, [draft, limits]);

  function setField(channel: string, field: "daily_max" | "hourly_max", value: string) {
    // Allow only non-negative integers (or blank = no cap).
    if (value !== "" && !/^\d+$/.test(value)) return;
    setDraft((prev) => ({ ...prev, [channel]: { ...prev[channel], [field]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const rows = CHANNELS.map(({ channel }) => ({
        channel,
        daily_max: draft[channel]?.daily_max === "" ? null : Number(draft[channel]?.daily_max),
        hourly_max: draft[channel]?.hourly_max === "" ? null : Number(draft[channel]?.hourly_max),
        updated_at: new Date().toISOString(),
      }));
      // channel is UNIQUE, so upsert keyed on it keeps one row per channel.
      const { error } = await supabase.from("channel_limits").upsert(rows as any, { onConflict: "channel" });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["channel_limits"] });
      toast.success("Send limits saved — new pacing applies to future scheduling");
    } catch (err: any) {
      toast.error(err?.message || "Failed to save send limits");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading send limits...
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Send Limits</h2>
        <p className="text-sm text-muted-foreground">
          Per-channel caps the sequence engine enforces. When a day or hour hits
          its cap, scheduling rolls the next send forward instead of bursting.
          Leave a field blank for no cap.
        </p>
      </div>

      <div className="rounded-lg border border-border divide-y">
        <div className="grid grid-cols-[1fr_7rem_7rem] gap-3 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Channel</span>
          <span className="text-right">Per day</span>
          <span className="text-right">Per hour</span>
        </div>
        {CHANNELS.map(({ channel, label, icon: Icon, hint }) => (
          <div key={channel} className="grid grid-cols-[1fr_7rem_7rem] items-center gap-3 px-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">{label}</p>
                <p className="text-[11px] text-muted-foreground truncate">{hint}</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="sr-only" htmlFor={`${channel}-daily`}>{label} per day</Label>
              <Input
                id={`${channel}-daily`}
                inputMode="numeric"
                className="h-8 text-right"
                placeholder="∞"
                value={draft[channel]?.daily_max ?? ""}
                onChange={(e) => setField(channel, "daily_max", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="sr-only" htmlFor={`${channel}-hourly`}>{label} per hour</Label>
              <Input
                id={`${channel}-hourly`}
                inputMode="numeric"
                className="h-8 text-right"
                placeholder="∞"
                value={draft[channel]?.hourly_max ?? ""}
                onChange={(e) => setField(channel, "hourly_max", e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="gold" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save Limits
        </Button>
      </div>
    </div>
  );
}
