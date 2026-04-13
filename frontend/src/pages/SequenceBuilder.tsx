import { useState, useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { MainLayout } from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SequenceSetup, type SequenceSetupData } from "@/components/sequences/SequenceSetup";
import { FlowBuilder, type FlowNodeData, type FlowEdgeData } from "@/components/sequences/FlowBuilder";
import { SequenceReview } from "@/components/sequences/SequenceReview";
import { toast } from "sonner";

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

  const [flowNodes, setFlowNodes] = useState<FlowNodeData[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdgeData[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("setup");

  // Load existing sequence when editing
  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data: seq } = await supabase
        .from("sequences")
        .select("*")
        .eq("id", id)
        .single() as any;
      if (seq) {
        setSetup({
          name: seq.name || "",
          jobId: seq.job_id,
          audienceType: seq.audience_type,
          objective: seq.objective || "",
          sendWindowStart: (seq.send_window_start || "09:00").slice(0, 5),
          sendWindowEnd: (seq.send_window_end || "18:00").slice(0, 5),
          timezone: seq.timezone || "America/New_York",
          senderUserId: seq.sender_user_id || seq.created_by,
        });
      }
    })();
  }, [id]);

  const handleFlowChange = useCallback((nodes: FlowNodeData[], edges: FlowEdgeData[]) => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
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
            .select("full_name, first_name, last_name")
            .eq("id", setup.senderUserId)
            .maybeSingle() as any;
          senderName =
            profile?.full_name ||
            `${profile?.first_name || ""} ${profile?.last_name || ""}`.trim() ||
            "";
          // Map sender to title (Emerald convention)
          if (senderName.toLowerCase().includes("chris")) senderTitle = "President";
          else if (senderName.toLowerCase().includes("nancy")) senderTitle = "Managing Director";
          else if (senderName.toLowerCase().includes("ashley")) senderTitle = "Recruiter";
        }

        const totalSteps = flowNodes.filter((n) => n.type === "action").length;

        toast.info("Joe is drafting...", { duration: 2000 });

        const response = await fetch("/api/draft-sequence-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: action.channel,
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
    [setup, flowNodes],
  );

  const saveSequence = useCallback(async () => {
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
          } as any)
          .eq("id", sequenceId);

        // Clear existing nodes/branches for re-save
        await supabase.from("sequence_nodes").delete().eq("sequence_id", sequenceId);
      }

      // 2. Create nodes
      const nodeIdMap: Record<string, string> = {};
      for (const node of flowNodes) {
        const { data: dbNode, error } = await supabase
          .from("sequence_nodes")
          .insert({
            sequence_id: sequenceId,
            node_order: node.nodeOrder,
            node_type: node.type,
            label: node.label,
          } as any)
          .select("id")
          .single();

        if (error) throw error;
        nodeIdMap[node.id] = dbNode.id;

        // 3. Create actions for action nodes
        if (node.type === "action" && node.actions) {
          for (const action of node.actions) {
            const { error: actionErr } = await supabase.from("sequence_actions").insert({
              node_id: dbNode.id,
              channel: action.channel,
              message_body: action.messageBody,
              base_delay_hours: action.baseDelayHours,
              delay_interval_minutes: action.delayIntervalMinutes,
              jiggle_minutes: action.jiggleMinutes,
              post_connection_hardcoded_hours: action.postConnectionHardcodedHours,
              respect_send_window: action.respectSendWindow,
            } as any);
            if (actionErr) throw new Error(`Action save failed (${node.label}): ${actionErr.message}`);
          }
        }
      }

      // No branches — flat delay-based model. All timing is on the actions.

      return sequenceId;
    } catch (err: any) {
      toast.error(`Save failed: ${err.message}`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [setup, flowNodes, flowEdges, id, user]);

  const handleSaveDraft = useCallback(async () => {
    const seqId = await saveSequence();
    if (seqId) {
      toast.success("Sequence saved as draft");
      if (!id) navigate(`/sequences/${seqId}/edit`, { replace: true });
    }
  }, [saveSequence, id, navigate]);

  const handleActivate = useCallback(async () => {
    const seqId = await saveSequence();
    if (seqId) {
      toast.success("Sequence activated");
      navigate(`/sequences/${seqId}/schedule`);
    }
  }, [saveSequence, navigate]);

  return (
    <MainLayout>
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{isEdit ? "Edit Sequence" : "New Sequence"}</h1>
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
            <FlowBuilder onChange={handleFlowChange} onAskJoe={handleAskJoe} />
            <div className="mt-4 flex justify-between items-center">
              <Button variant="outline" onClick={() => setActiveTab("setup")}>Back</Button>
              <div className="text-xs text-muted-foreground">
                {flowNodes.filter((n) => n.type === "action").length} action node(s),{" "}
                {flowNodes.filter((n) => n.type === "action").reduce((sum, n) => sum + (n.actions?.length || 0), 0)}{" "}
                total action(s)
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
                nodes={flowNodes}
                edges={flowEdges}
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
