import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Progress } from "@/components/ui/progress";
import { Linkedin, Mail, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// Channels surfaced in the bar. Keep this short — recruiters only act on
// the channels with caps that bite (LinkedIn invite, LinkedIn message,
// email). SMS rarely caps; manual_call has no cap; InMail has its own
// per-account credit display in EnrollDialog.
const CHANNELS = [
  { key: "linkedin_connection", label: "LI invite", icon: Linkedin, fallbackMax: 35 },
  { key: "linkedin_message", label: "LI msg", icon: Linkedin, fallbackMax: 40 },
  { key: "email", label: "Email", icon: Mail, fallbackMax: 150 },
  { key: "sms", label: "SMS", icon: MessageSquare, fallbackMax: 50 },
] as const;

interface Row {
  channel: string;
  current: number;
  max: number;
}

/** EST date in YYYY-MM-DD — must match incrementDailySend's send_date. */
function estToday(): string {
  // Use Canadian English locale to get YYYY-MM-DD shape directly.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface Props {
  /** Optional account scope. When set, only counts the row's account.
   *  When omitted, sums across every account on the tenant. */
  accountId?: string;
  className?: string;
  /** Compact (inline) layout for tight contexts like a Send From hint. */
  compact?: boolean;
}

/**
 * Today's send utilization, per channel. Reads daily_send_log (already
 * incremented at send time by sequence-scheduler.ts) and channel_limits.
 * Falls back to hardcoded caps when channel_limits has no row, so the
 * bar never silently shows 0/0.
 */
export function DailyUtilization({ accountId, className, compact }: Props) {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const today = estToday();
      let q = supabase
        .from("daily_send_log")
        .select("channel, count")
        .eq("send_date", today);
      if (accountId) q = q.eq("account_id", accountId);
      const { data: counts } = (await q) as any;

      const { data: limits } = await supabase
        .from("channel_limits")
        .select("channel, daily_max") as any;

      if (cancelled) return;

      const sum: Record<string, number> = {};
      for (const r of counts || []) {
        sum[r.channel] = (sum[r.channel] || 0) + (r.count || 0);
      }
      const limitMap: Record<string, number> = {};
      for (const l of limits || []) {
        if (l.daily_max) limitMap[l.channel] = l.daily_max;
      }

      setRows(
        CHANNELS.map((c) => ({
          channel: c.key,
          current: sum[c.key] || 0,
          max: limitMap[c.key] || c.fallbackMax,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground", className)}>
        {rows.map((row) => {
          const channel = CHANNELS.find((c) => c.key === row.channel)!;
          const Icon = channel.icon;
          const pct = row.max ? (row.current / row.max) * 100 : 0;
          const hot = pct >= 80;
          return (
            <span key={row.channel} className="inline-flex items-center gap-1">
              <Icon className="h-3 w-3" />
              {channel.label}
              <span className={cn("font-mono", hot && "text-amber-600 font-semibold")}>
                {row.current}/{row.max}
              </span>
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-4 gap-3", className)}>
      {rows.map((row) => {
        const channel = CHANNELS.find((c) => c.key === row.channel)!;
        const Icon = channel.icon;
        const pct = row.max ? Math.min((row.current / row.max) * 100, 100) : 0;
        return (
          <div key={row.channel} className="rounded-md border border-card-border bg-card/40 px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Icon className="h-3 w-3" />
                {channel.label}
              </span>
              <span className="font-mono text-foreground">
                {row.current}/{row.max}
              </span>
            </div>
            <Progress value={pct} className="h-1.5 mt-1.5" />
          </div>
        );
      })}
    </div>
  );
}
