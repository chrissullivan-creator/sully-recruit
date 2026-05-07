import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Users, MessageSquare, Calendar, TrendingUp, PieChart, Eye, Send } from "lucide-react";
import { PieChart as RechartsPie, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

const SENTIMENT_COLORS: Record<string, string> = {
  interested: "#22c55e",
  not_interested: "#ef4444",
  maybe_later: "#eab308",
  booked_meeting: "#3b82f6",
  hostile: "#dc2626",
  auto_reply: "#9ca3af",
};

const CHANNEL_COLORS: Record<string, string> = {
  linkedin_connection: "#2563eb",
  linkedin_message: "#3b82f6",
  linkedin_inmail: "#6366f1",
  email: "#22c55e",
  sms: "#eab308",
  manual_call: "#f97316",
};

export default function SequenceAnalyticsPage() {
  const { id } = useParams();
  const [sequence, setSequence] = useState<any>(null);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [stepLogs, setStepLogs] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  async function loadData() {
    const [seqRes, enrollRes, logRes, nodeRes] = await Promise.all([
      supabase.from("sequences").select("*, jobs(title)").eq("id", id).single(),
      supabase.from("sequence_enrollments").select("*").eq("sequence_id", id),
      supabase.from("sequence_step_logs").select("*, sequence_enrollments!inner(sequence_id)").eq("sequence_enrollments.sequence_id", id),
      // Per-step funnel needs node_order so we can label each row
      // "Step N" instead of just node_id.
      supabase.from("sequence_nodes").select("id, node_order, label, sequence_actions(channel)").eq("sequence_id", id),
    ]);

    setSequence((seqRes as any).data);
    setEnrollments((enrollRes as any).data || []);
    setStepLogs((logRes as any).data || []);
    setNodes((nodeRes as any).data || []);
    setLoading(false);
  }

  const metrics = useMemo(() => {
    const total = enrollments.length;
    const active = enrollments.filter((e) => e.status === "active").length;
    const stopped = enrollments.filter((e) => e.status === "stopped").length;
    const completed = enrollments.filter((e) => e.status === "completed").length;
    const replied = enrollments.filter((e) => e.stop_trigger === "reply_received").length;
    const calendarBooked = enrollments.filter((e) => e.stop_trigger === "calendar_booked").length;

    const sent = stepLogs.filter((l) => l.status === "sent").length;
    const failed = stepLogs.filter((l) => l.status === "failed").length;
    const skipped = stepLogs.filter((l) => l.status === "skipped").length;
    const scheduled = stepLogs.filter((l) => l.status === "scheduled").length;

    // Email-only open metrics — opens come from the 1×1 tracking pixel
    // appended to outbound sequence emails (see send-channels.ts).
    // open_count tracks repeated opens; opened_at marks the first open.
    const sentEmails = stepLogs.filter((l) => l.status === "sent" && l.channel === "email");
    const openedEmails = sentEmails.filter((l) => l.opened_at);
    const totalOpens = sentEmails.reduce((sum, l) => sum + (Number(l.open_count) || 0), 0);
    const openRate = sentEmails.length > 0
      ? ((openedEmails.length / sentEmails.length) * 100).toFixed(1)
      : "0";

    const replyRate = total > 0 ? ((replied / total) * 100).toFixed(1) : "0";
    const meetingRate = total > 0 ? ((calendarBooked / total) * 100).toFixed(1) : "0";
    const completionRate = total > 0 ? ((completed / total) * 100).toFixed(1) : "0";

    return {
      total, active, stopped, completed, replied, calendarBooked,
      sent, failed, skipped, scheduled,
      sentEmailsCount: sentEmails.length,
      uniqueOpens: openedEmails.length,
      totalOpens,
      openRate,
      replyRate, meetingRate, completionRate,
    };
  }, [enrollments, stepLogs]);

  // Sentiment breakdown
  const sentimentData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const log of stepLogs) {
      if (log.sentiment) {
        counts[log.sentiment] = (counts[log.sentiment] || 0) + 1;
      }
    }
    return Object.entries(counts).map(([name, value]) => ({
      name,
      value,
      color: SENTIMENT_COLORS[name] || "#6b7280",
    }));
  }, [stepLogs]);

  // Per-channel reply rates
  const channelStats = useMemo(() => {
    const byChannel: Record<string, { sent: number; replies: number; opens: number }> = {};
    for (const log of stepLogs) {
      if (!log.channel) continue;
      if (!byChannel[log.channel]) byChannel[log.channel] = { sent: 0, replies: 0, opens: 0 };
      if (log.status === "sent") byChannel[log.channel].sent++;
      if (log.reply_received_at) byChannel[log.channel].replies++;
      if ((log as any).opened_at) byChannel[log.channel].opens++;
    }
    return Object.entries(byChannel).map(([channel, stats]) => ({
      channel: channel.replace(/_/g, " "),
      sent: stats.sent,
      replies: stats.replies,
      opens: stats.opens,
      replyRate: stats.sent > 0 ? Number(((stats.replies / stats.sent) * 100).toFixed(1)) : 0,
      openRate: stats.sent > 0 ? Number(((stats.opens / stats.sent) * 100).toFixed(1)) : 0,
      color: CHANNEL_COLORS[channel] || "#6b7280",
    }));
  }, [stepLogs]);

  // Per-step funnel — group step_logs by node_id, label by node_order.
  // Email steps surface open + reply rates; non-email steps just show
  // sent / replied since opens don't apply.
  const stepStats = useMemo(() => {
    const byNode: Record<string, { sent: number; opens: number; replies: number; channel: string }> = {};
    for (const log of stepLogs) {
      const nid = (log as any).node_id;
      if (!nid) continue;
      if (!byNode[nid]) byNode[nid] = { sent: 0, opens: 0, replies: 0, channel: log.channel || "" };
      if (log.status === "sent") byNode[nid].sent++;
      if ((log as any).opened_at) byNode[nid].opens++;
      if (log.reply_received_at) byNode[nid].replies++;
    }
    return [...nodes]
      .sort((a: any, b: any) => (a.node_order || 0) - (b.node_order || 0))
      .map((n: any) => {
        const s = byNode[n.id] || { sent: 0, opens: 0, replies: 0, channel: "" };
        const channel = n.sequence_actions?.[0]?.channel || s.channel || "—";
        return {
          stepLabel: `Step ${n.node_order ?? "?"}`,
          channel,
          sent: s.sent,
          opens: s.opens,
          replies: s.replies,
          openRate: s.sent > 0 && channel === "email"
            ? Number(((s.opens / s.sent) * 100).toFixed(1))
            : null,
          replyRate: s.sent > 0 ? Number(((s.replies / s.sent) * 100).toFixed(1)) : 0,
        };
      });
  }, [nodes, stepLogs]);

  // Note: an earlier "connection accept rate" KPI lived here. It was a bogus
  // proxy (any non-reply non-active enrollment counted as accepted, which
  // includes calendar_booked / completed / timed-out). Removed until we
  // track real LinkedIn invite-accepted webhooks distinctly from sends.

  if (loading) return <MainLayout><div className="container mx-auto py-6">Loading...</div></MainLayout>;

  return (
    <MainLayout>
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/sequences/${id}/edit`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{sequence?.name} — Analytics</h1>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Enrolled</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.total}</p>
            <p className="text-xs text-muted-foreground">{metrics.active} active</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Sends</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.sent}</p>
            <p className="text-xs text-muted-foreground">
              {metrics.scheduled} scheduled, {metrics.skipped} skipped, {metrics.failed} failed
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Open Rate</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.openRate}%</p>
            <p className="text-xs text-muted-foreground">
              {metrics.uniqueOpens}/{metrics.sentEmailsCount} email{metrics.sentEmailsCount === 1 ? "" : "s"} ({metrics.totalOpens} total opens)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Reply Rate</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.replyRate}%</p>
            <p className="text-xs text-muted-foreground">{metrics.replied} replies</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Meeting Booked</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.meetingRate}%</p>
            <p className="text-xs text-muted-foreground">{metrics.calendarBooked} meetings</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Completion Rate</span>
            </div>
            <p className="text-2xl font-bold mt-1">{metrics.completionRate}%</p>
            <p className="text-xs text-muted-foreground">{metrics.completed} completed</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Sentiment pie chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <PieChart className="h-4 w-4" /> Sentiment Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sentimentData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No sentiment data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <RechartsPie>
                  <Pie
                    data={sentimentData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ name, value }) => `${name} (${value})`}
                  >
                    {sentimentData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </RechartsPie>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Per-channel funnel: Sent → Opens → Replies */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Funnel by Channel (Sent → Opens → Replies)</CardTitle>
          </CardHeader>
          <CardContent>
            {channelStats.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={channelStats}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="channel" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="sent" fill="#94a3b8" name="Sent" />
                  <Bar dataKey="opens" fill="#3b82f6" name="Opens" />
                  <Bar dataKey="replies" fill="#22c55e" name="Replies" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-step funnel — sent / opens / replies for each node, in order */}
      {stepStats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Per-step Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-2 px-2 font-medium">Step</th>
                    <th className="text-left py-2 px-2 font-medium">Channel</th>
                    <th className="text-right py-2 px-2 font-medium">Sent</th>
                    <th className="text-right py-2 px-2 font-medium">Opens</th>
                    <th className="text-right py-2 px-2 font-medium">Open Rate</th>
                    <th className="text-right py-2 px-2 font-medium">Replies</th>
                    <th className="text-right py-2 px-2 font-medium">Reply Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stepStats.map((s) => (
                    <tr key={s.stepLabel} className="border-b last:border-0">
                      <td className="py-1.5 px-2">{s.stepLabel}</td>
                      <td className="py-1.5 px-2 capitalize">{s.channel.replace(/_/g, " ")}</td>
                      <td className="py-1.5 px-2 text-right">{s.sent}</td>
                      <td className="py-1.5 px-2 text-right">{s.openRate === null ? "—" : s.opens}</td>
                      <td className="py-1.5 px-2 text-right">{s.openRate === null ? "—" : `${s.openRate}%`}</td>
                      <td className="py-1.5 px-2 text-right">{s.replies}</td>
                      <td className="py-1.5 px-2 text-right">{s.sent > 0 ? `${s.replyRate}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pipeline outcomes (if tied to job) */}
      {sequence?.job_id && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pipeline Outcomes — {sequence.jobs?.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Badge variant="outline">Reached: {metrics.total}</Badge>
              <Badge variant="outline">Responded: {metrics.replied}</Badge>
              <Badge variant="outline">Meetings: {metrics.calendarBooked}</Badge>
              <Badge variant="outline">Not Interested: {sentimentData.find((s) => s.name === "not_interested")?.value || 0}</Badge>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </MainLayout>
  );
}
