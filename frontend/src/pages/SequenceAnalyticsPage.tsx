import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Users, MessageSquare, Calendar, TrendingUp, PieChart } from "lucide-react";
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  async function loadData() {
    const [seqRes, enrollRes, logRes] = await Promise.all([
      supabase.from("sequences").select("*, jobs(title)").eq("id", id).single(),
      supabase.from("sequence_enrollments").select("*").eq("sequence_id", id),
      supabase.from("sequence_step_logs").select("*, sequence_enrollments!inner(sequence_id)").eq("sequence_enrollments.sequence_id", id),
    ]);

    setSequence((seqRes as any).data);
    setEnrollments((enrollRes as any).data || []);
    setStepLogs((logRes as any).data || []);
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
    const scheduled = stepLogs.filter((l) => l.status === "scheduled").length;

    const replyRate = total > 0 ? ((replied / total) * 100).toFixed(1) : "0";
    const meetingRate = total > 0 ? ((calendarBooked / total) * 100).toFixed(1) : "0";
    const completionRate = total > 0 ? ((completed / total) * 100).toFixed(1) : "0";

    return { total, active, stopped, completed, replied, calendarBooked, sent, failed, scheduled, replyRate, meetingRate, completionRate };
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
    const byChannel: Record<string, { sent: number; replies: number }> = {};
    for (const log of stepLogs) {
      if (!log.channel) continue;
      if (!byChannel[log.channel]) byChannel[log.channel] = { sent: 0, replies: 0 };
      if (log.status === "sent") byChannel[log.channel].sent++;
      if (log.reply_received_at) byChannel[log.channel].replies++;
    }
    return Object.entries(byChannel).map(([channel, stats]) => ({
      channel: channel.replace(/_/g, " "),
      sent: stats.sent,
      replies: stats.replies,
      replyRate: stats.sent > 0 ? Number(((stats.replies / stats.sent) * 100).toFixed(1)) : 0,
      color: CHANNEL_COLORS[channel] || "#6b7280",
    }));
  }, [stepLogs]);

  // Connection accept rate (LinkedIn connections)
  const connectionStats = useMemo(() => {
    const connectionSends = stepLogs.filter((l) => l.channel === "linkedin_connection" && l.status === "sent").length;
    const accepted = enrollments.filter((e) => e.stop_trigger !== "reply_received" && e.status !== "active").length; // rough proxy
    return { sent: connectionSends, rate: connectionSends > 0 ? ((accepted / connectionSends) * 100).toFixed(1) : "0" };
  }, [stepLogs, enrollments]);

  if (loading) return <div className="container mx-auto py-6">Loading...</div>;

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/sequences/${id}/edit`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{sequence?.name} — Analytics</h1>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            <p className="text-xs text-muted-foreground">{metrics.sent} sent, {metrics.failed} failed</p>
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

        {/* Per-channel reply rates */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Reply Rate by Channel</CardTitle>
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
                  <Bar dataKey="replies" fill="#22c55e" name="Replies" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

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
  );
}
