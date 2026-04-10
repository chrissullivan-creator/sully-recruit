import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Pause, SkipForward, Calendar } from "lucide-react";
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

export default function SequenceScheduleView() {
  const { id } = useParams();
  const [sequence, setSequence] = useState<any>(null);
  const [sends, setSends] = useState<ScheduledSend[]>([]);
  const [dailyCounts, setDailyCounts] = useState<Record<string, number>>({});
  const [view, setView] = useState<"day" | "week">("week");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  async function loadData() {
    // Load sequence
    const { data: seq } = await supabase
      .from("sequences")
      .select("*")
      .eq("id", id)
      .single() as any;
    setSequence(seq);

    // Load scheduled step logs with enrollment details
    const { data: logs } = await supabase
      .from("sequence_step_logs")
      .select(`
        id, enrollment_id, channel, scheduled_at, status,
        sequence_enrollments!inner(
          candidate_id, contact_id,
          candidates(first_name, last_name),
          contacts(first_name, last_name)
        )
      `)
      .eq("sequence_enrollments.sequence_id", id)
      .in("status", ["scheduled", "sent"])
      .order("scheduled_at", { ascending: true }) as any;

    if (logs) {
      const mapped: ScheduledSend[] = logs.map((log: any) => {
        const enrollment = log.sequence_enrollments;
        const candidate = enrollment?.candidates;
        const contact = enrollment?.contacts;
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
          entityName: name,
          entityId: enrollment?.candidate_id || enrollment?.contact_id,
          entityType: enrollment?.candidate_id ? "candidate" : "contact",
        };
      });
      setSends(mapped);
    }

    // Load daily send counts
    const { data: dailyLogs } = await supabase
      .from("daily_send_log")
      .select("channel, send_date, count")
      .order("send_date", { ascending: false })
      .limit(100) as any;

    if (dailyLogs) {
      const counts: Record<string, number> = {};
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      for (const log of dailyLogs) {
        if (log.send_date === today) {
          counts[log.channel] = (counts[log.channel] || 0) + log.count;
        }
      }
      setDailyCounts(counts);
    }

    setLoading(false);
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

  const handlePauseSend = async (logId: string) => {
    await supabase.from("sequence_step_logs").update({ status: "skipped" } as any).eq("id", logId);
    setSends((prev) => prev.filter((s) => s.id !== logId));
    toast.success("Send skipped");
  };

  if (loading) return <div className="container mx-auto py-6">Loading...</div>;

  return (
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
                                onClick={() => handlePauseSend(send.id)}
                                title="Skip this send"
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
  );
}
