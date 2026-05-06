import { useState, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { MainLayout } from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SequenceSetup, type SequenceSetupData } from "@/components/sequences/SequenceSetup";
import { FlowBuilder, type SequenceBranch } from "@/components/sequences/FlowBuilder";
import { SequenceReview } from "@/components/sequences/SequenceReview";
import { compareSequenceNodes, createEmptyBranches, flattenBranchSteps, hydrateBranchesFromNodes, normalizeBranches } from "@/components/sequences/sequenceBranches";
import { toast } from "sonner";

function toTimeInput(value: unknown, fallback: string) {
  if (typeof value === "string" && /^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${String(value).padStart(2, "0")}:00`;
  }
  return fallback;
}

export default function SequenceBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isEdit = !!id;

  const [setup, setSetup] = useState<SequenceSetupData>({
    name: "",
    jobId: null,
    audienceType: "candidates",
    objective: "",
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    timezone: "America/New_York",
    senderUserId: null,
  });

  const [branches, setBranches] = useState<SequenceBranch[]>(createEmptyBranches());
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState(isEdit ? "flow" : "setup");

  // Load existing sequence when editing
  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data: seq } = await supabase
        .from("sequences")
        .select("*, sequence_nodes(id, node_order, node_type, label, branch_id, branch_step_order, sequence_actions(*)), sequence_steps(*)")
        .eq("id", id)
        .single() as any;
      if (seq) {
        setSetup({
          name: seq.name || "",
          jobId: seq.job_id,
          audienceType: seq.audience_type,
          objective: seq.objective || "",
          sendWindowStart: toTimeInput(seq.send_window_start, "09:00"),
          sendWindowEnd: toTimeInput(seq.send_window_end, "18:00"),
          timezone: seq.timezone || "America/New_York",
          senderUserId: seq.sender_user_id || seq.created_by,
        });

        const nodeRows = ((seq.sequence_nodes || []) as any[]).sort(compareSequenceNodes);
        setBranches(hydrateBranchesFromNodes(nodeRows, seq.sequence_steps || []));
      }
    })();
  }, [id]);

  const handleFlowChange = useCallback((nextBranches: SequenceBranch[]) => {
    setBranches(normalizeBranches(nextBranches));
  }, []);

  // Ask Joe to draft a message for an action
  const handleAskJoe = useCallback(
    async (
      action: any,
      stepNumber: number,
      stepLabel: string,
      previousMessages: Array<{ channel: string; body: string }>,
    ): Promise<string> => {
      try {
        // Load job details if the sequence is tied to a job
        let jobDetails: any = null;
        if (setup.jobId) {
          const { data: job } = await supabase
            .from("jobs")
            .select("title, company_name, description")
            .eq("id", setup.jobId)
            .maybeSingle() as any;
          jobDetails = job;
        }

        // Load sender profile
        let senderName = "";
        let senderTitle = "";
        if (setup.senderUserId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, first_name, last_name, title")
            .eq("id", setup.senderUserId)
            .maybeSingle() as any;
          senderName =
            profile?.full_name ||
            `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() ||
            "";
          // Use title from profiles table if available, fall back to name-based lookup
          senderTitle = profile?.title || "";
          if (!senderTitle) {
            const nameLower = senderName.toLowerCase();
            if (nameLower.includes("chris")) senderTitle = "President";
            else if (nameLower.includes("nancy")) senderTitle = "Managing Director";
            else if (nameLower.includes("ashley")) senderTitle = "Recruiter";
          }
        }

        const totalSteps = flattenBranchSteps(branches).length;

        toast.info("Joe is drafting...", { duration: 2000 });

        const response = await fetch("/api/draft-sequence-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: action.channel,
            step_type: action.channel,
            step_number: stepNumber,
            step_label: stepLabel || undefined,
            total_steps: totalSteps,
            audience_type: setup.audienceType,
            sequence_name: setup.name,
            sequence_objective: setup.objective,
            sender_name: senderName,
            sender_title: senderTitle,
            job_title: jobDetails?.title,
            job_company: jobDetails?.company_name,
            job_description: jobDetails?.description,
            previous_messages: previousMessages,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        if (!result.message) throw new Error("Joe returned no message");

        toast.success("Joe drafted a message");
        return result.message;
      } catch (err: any) {
        toast.error(`Joe failed: ${err.message}`);
        return "";
      }
    },
    [setup, branches],
  );

  const saveSequence = useCallback(async (status: "draft" | "active") => {
    if (!setup.name) {
      toast.error("Sequence name is required");
      return null;
    }
    if (!user?.id) {
      toast.error("Not authenticated");
      return null;
    }

    setSaving(true);
    try {
      // 1. Create or update the sequence
      let sequenceId = id;
      if (!sequenceId) {
        const { data: seq, error } = await supabase
          .from("sequences")
          .insert({
            name: setup.name,
            job_id: setup.jobId,
            audience_type: setup.audienceType,
            objective: setup.objective,
            send_window_start: setup.sendWindowStart,
            send_window_end: setup.sendWindowEnd,
            timezone: setup.timezone,
            created_by: user.id,
            sender_user_id: setup.senderUserId || user.id,
            status,
          } as any)
          .select("id")
          .single();

        if (error) throw error;
        sequenceId = seq.id;
      } else {
        await supabase
          .from("sequences")
          .update({
            name: setup.name,
            job_id: setup.jobId,
            audience_type: setup.audienceType,
            objective: setup.objective,
            send_window_start: setup.sendWindowStart,
            send_window_end: setup.sendWindowEnd,
            timezone: setup.timezone,
            sender_user_id: setup.senderUserId || user.id,
            status,
          } as any)
          .eq("id", sequenceId);

        // Clear existing nodes/branches for re-save
        await supabase.from("sequence_nodes").delete().eq("sequence_id", sequenceId);
      }

      // 2. Create nodes in deterministic branch order
      for (const step of flattenBranchSteps(branches)) {
        const { data: dbNode, error } = await supabase
          .from("sequence_nodes")
          .insert({
            sequence_id: sequenceId,
            node_order: step.nodeOrder,
            node_type: "action",
            label: step.label,
            branch_id: step.branchId,
            branch_step_order: step.branchStepOrder,
          } as any)
          .select("id")
          .single();

        if (error) throw error;

        // 3. Create actions for action nodes
        for (const action of step.actions || []) {
          const { error: actionErr } = await supabase.from("sequence_actions").insert({
            node_id: dbNode.id,
            channel: action.channel,
            message_body: action.messageBody,
            base_delay_hours: action.baseDelayHours,
            delay_interval_minutes: action.delayIntervalMinutes,
            jiggle_minutes: action.jiggleMinutes,
            post_connection_hardcoded_hours: action.postConnectionHardcodedHours,
            respect_send_window: action.respectSendWindow,
            use_signature: action.channel === "email" ? (action.useSignature !== false) : false,
            // Attachments persist for channels that actually send a
            // file: email (Microsoft Graph fileAttachment) and Unipile
            // LinkedIn message / InMail (multipart `attachments` field).
            // SMS / connection requests / manual_call don't carry files.
            attachment_url:
              action.channel === "email"
                || action.channel === "linkedin_message"
                || action.channel === "linkedin_inmail"
                ? (action.attachmentUrl || null)
                : null,
          } as any);
          if (actionErr) throw new Error(`Action save failed (${step.label || `${step.branchId} step ${step.branchStepOrder}`}): ${actionErr.message}`);
        }
      }
      return sequenceId;
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [setup, branches, id, user]);

  const handleSaveDraft = useCallback(async () => {
    const seqId = await saveSequence("draft");
    if (seqId) {
      toast.success("Sequence saved as draft");
      if (!id) navigate(`/sequences/${seqId}/edit`, { replace: true });
    }
  }, [saveSequence, id, navigate]);

  const handleActivate = useCallback(async () => {
    const seqId = await saveSequence("active");
    if (seqId) {
      toast.success("Sequence activated");
      navigate(`/sequences/${seqId}/schedule`);
    }
  }, [saveSequence, navigate]);

  return (
    <MainLayout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-display font-semibold uppercase tracking-wider text-muted-foreground">
              {isEdit ? "Editing sequence" : "New sequence"}
            </p>
            <h1 className="text-2xl font-bold truncate">
              {isEdit
                ? (setup.name?.trim() || <span className="text-muted-foreground italic">Untitled sequence</span>)
                : "New Sequence"}
            </h1>
            {isEdit && id && (
              <p className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">id: {id}</p>
            )}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="setup">1. Setup</TabsTrigger>
          <TabsTrigger value="flow">2. Flow Builder</TabsTrigger>
          <TabsTrigger value="review">3. Review</TabsTrigger>
        </TabsList>

          <TabsContent value="setup" className="mt-4">
            <div className="max-w-2xl">
              <SequenceSetup data={setup} onChange={setSetup} />
              <div className="mt-4 flex justify-end">
                <Button onClick={() => setActiveTab("flow")}>
                  Next: Build Flow
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="flow" className="mt-4">
            <FlowBuilder
              initialBranches={branches}
              onChange={handleFlowChange}
              onAskJoe={handleAskJoe}
            />
            <div className="mt-4 flex justify-between items-center">
              <Button variant="outline" onClick={() => setActiveTab("setup")}>Back</Button>
              <div className="text-xs text-muted-foreground">
                {flattenBranchSteps(branches).length} total step(s),{" "}
                {flattenBranchSteps(branches).reduce((sum, step) => sum + (step.actions?.length || 0), 0)} total action(s)
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleSaveDraft} disabled={saving}>
                  Save Draft
                </Button>
                <Button onClick={() => setActiveTab("review")}>Next: Review</Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="review" className="mt-4">
            <div className="max-w-2xl">
              <SequenceReview
                setup={setup}
                branches={branches}
                onSaveDraft={handleSaveDraft}
                onActivate={handleActivate}
                saving={saving}
              />
              <div className="mt-4">
                <Button variant="outline" onClick={() => setActiveTab("flow")}>Back</Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
}
