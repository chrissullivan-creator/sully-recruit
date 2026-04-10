import { useState, useCallback } from "react";
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
  });

  const [flowNodes, setFlowNodes] = useState<FlowNodeData[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdgeData[]>([]);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("setup");

  const handleFlowChange = useCallback((nodes: FlowNodeData[], edges: FlowEdgeData[]) => {
    setFlowNodes(nodes);
    setFlowEdges(edges);
  }, []);

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
            await supabase.from("sequence_actions").insert({
              node_id: dbNode.id,
              channel: action.channel,
              message_body: action.messageBody,
              base_delay_hours: action.baseDelayHours,
              delay_interval_minutes: action.delayIntervalMinutes,
              jiggle_minutes: action.jiggleMinutes,
              post_connection_hardcoded_hours: action.postConnectionHardcodedHours,
              respect_send_window: action.respectSendWindow,
            } as any);
          }
        }
      }

      // 4. Create branches from edges
      for (const edge of flowEdges) {
        const fromDbId = nodeIdMap[edge.source];
        const toDbId = nodeIdMap[edge.target];
        if (!fromDbId || !toDbId) continue;

        await supabase.from("sequence_branches").insert({
          from_node_id: fromDbId,
          to_node_id: toDbId,
          condition: edge.condition || "no_response",
          after_days: edge.afterDays || null,
        } as any);
      }

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
            <FlowBuilder onChange={handleFlowChange} />
            <div className="mt-4 flex justify-between">
              <Button variant="outline" onClick={() => setActiveTab("setup")}>Back</Button>
              <Button onClick={() => setActiveTab("review")}>Next: Review</Button>
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
