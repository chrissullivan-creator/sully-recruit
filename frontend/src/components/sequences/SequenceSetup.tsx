import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Sparkles } from "lucide-react";

export interface SequenceSetupData {
  name: string;
  jobId: string | null;
  audienceType: "candidates" | "contacts";
  objective: string;
  sendWindowStart: string;
  sendWindowEnd: string;
  timezone: string;
  senderUserId: string | null;
}

interface Props {
  data: SequenceSetupData;
  onChange: (data: SequenceSetupData) => void;
  onAskJoe?: () => void;
}

export function SequenceSetup({ data, onChange, onAskJoe }: Props) {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<{ id: string; title: string; company_name: string | null; status: string }[]>([]);
  const [profiles, setProfiles] = useState<{ id: string; full_name: string | null; email: string | null }[]>([]);

  useEffect(() => {
    supabase
      .from("jobs")
      .select("id, title, company_name, status")
      .in("status", ["hot", "lead"])
      .order("status", { ascending: true })
      .order("title", { ascending: true })
      .then(({ data: jobData }) => {
        if (jobData) setJobs(jobData as any);
      });

    supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name", { ascending: true })
      .then(({ data: profileData }) => {
        if (profileData) setProfiles(profileData as any);
      });
  }, []);

  // Default sender to current user
  useEffect(() => {
    if (!data.senderUserId && user?.id) {
      onChange({ ...data, senderUserId: user.id });
    }
  }, [user?.id]);

  // Auto-fill objective when job is selected
  useEffect(() => {
    if (data.jobId && !data.objective) {
      const job = jobs.find((j) => j.id === data.jobId);
      if (job) {
        onChange({ ...data, objective: `Recruit candidates for ${job.title}${job.company_name ? ` at ${job.company_name}` : ""}` });
      }
    }
  }, [data.jobId]);

  const update = (field: keyof SequenceSetupData, value: any) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sequence Setup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Sequence Name</Label>
          <Input
            id="name"
            value={data.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="e.g. Senior Engineer Outreach"
          />
        </div>

        <div className="space-y-2">
          <Label>Send As</Label>
          <Select
            value={data.senderUserId || ""}
            onValueChange={(v) => update("senderUserId", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select sender" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.full_name || p.email || p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Messages will be sent from this recruiter's email, LinkedIn, and SMS accounts.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Tied to Job</Label>
          <Select
            value={data.jobId || "none"}
            onValueChange={(v) => update("jobId", v === "none" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a job (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {jobs.map((job) => (
                <SelectItem key={job.id} value={job.id}>
                  {job.status === "hot" ? "🔥 " : "📋 "}
                  {job.title}{job.company_name ? ` — ${job.company_name}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Target Audience</Label>
          <div className="flex items-center gap-3">
            <span className={data.audienceType === "candidates" ? "font-medium" : "text-muted-foreground"}>
              Candidates
            </span>
            <Switch
              checked={data.audienceType === "contacts"}
              onCheckedChange={(checked) => update("audienceType", checked ? "contacts" : "candidates")}
            />
            <span className={data.audienceType === "contacts" ? "font-medium" : "text-muted-foreground"}>
              Contacts
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="objective">Objective</Label>
          <Textarea
            id="objective"
            value={data.objective}
            onChange={(e) => update("objective", e.target.value)}
            placeholder="What's the goal of this sequence?"
            rows={3}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="windowStart">Send Window Start (EST)</Label>
            <Input
              id="windowStart"
              type="time"
              value={data.sendWindowStart}
              onChange={(e) => update("sendWindowStart", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="windowEnd">Send Window End (EST)</Label>
            <Input
              id="windowEnd"
              type="time"
              value={data.sendWindowEnd}
              onChange={(e) => update("sendWindowEnd", e.target.value)}
            />
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          LinkedIn connection requests ignore send window (fire 24/7). All other channels respect it.
        </p>

        {onAskJoe && (
          <Button variant="outline" className="w-full" onClick={onAskJoe}>
            <Sparkles className="h-4 w-4 mr-2" />
            Ask Joe to Write This Sequence
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
