import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ActionNode, type ActionData } from "./ActionNode";
import { WaitNode } from "./WaitNode";
import { BranchNode } from "./BranchNode";
import { EndNode } from "./EndNode";
import { Button } from "@/components/ui/button";
import { Plus, GitBranch, Clock, StopCircle, Zap, Wand2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types for serialization
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowNodeData {
  id: string;
  type: "action" | "wait" | "branch" | "end";
  label: string;
  actions?: ActionData[];
  waitDays?: number;
  condition?: string;
  afterDays?: number | null;
  nodeOrder: number;
}

export interface FlowEdgeData {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
  afterDays?: number | null;
}

interface Props {
  initialNodes?: FlowNodeData[];
  initialEdges?: FlowEdgeData[];
  onChange?: (nodes: FlowNodeData[], edges: FlowEdgeData[]) => void;
  onAskJoe?: (nodeId: string, actionIndex: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default starting flow — a single empty action node
// ─────────────────────────────────────────────────────────────────────────────

function createEmptyFlow(): { nodes: Node[]; edges: Edge[] } {
  const startAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "linkedin_inmail",
    messageBody: "Hi {{first_name}}, I'd love to connect about an opportunity.",
    baseDelayHours: 0,
    delayIntervalMinutes: 0,
    jiggleMinutes: 5,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
  };

  return {
    nodes: [
      {
        id: "node-1",
        type: "actionNode",
        position: { x: 250, y: 50 },
        data: {
          label: "Step 1",
          actions: [startAction],
          nodeOrder: 1,
        },
      },
    ],
    edges: [],
  };
}

/**
 * Quick-start template matching the "ideal sequence":
 *   Node 1: InMail (now) + Email (parallel, if email exists) + SMS (parallel, if phone exists)
 *   Node 2: LinkedIn connection request (24/7)
 *   Node 3: LinkedIn message (4h+ after connection accepted)
 *   Node end: terminate
 *
 * Branching:
 *   Node 1 → Node 2 via no_response after 1 day
 *   Node 2 → Node 3 via connection_accepted (4h+ post-acceptance delay)
 *   Node 2 → End via no_response after 7 days (never accepted)
 *   Node 3 → End via no_response after 3 days
 *
 * Any reply on any channel = auto-stop (handled by engine, no edges needed).
 * Email/SMS skip automatically if recipient has no email/phone.
 */
function createIdealTemplate(): { nodes: Node[]; edges: Edge[] } {
  const inmailAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "linkedin_inmail",
    messageBody:
      "Hi {{first_name}}, I'm {{sender_name}} at Emerald Recruiting. I came across your profile and think you'd be a great fit for {{job_name}}. Open to a quick chat?",
    baseDelayHours: 0,
    delayIntervalMinutes: 0,
    jiggleMinutes: 5,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
  };
  const emailAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "email",
    messageBody:
      "Hi {{first_name}},\n\nI'm {{sender_name}} at Emerald Recruiting. I'm working on {{job_name}} at {{company}} and think your background is a strong match. Would you be open to a quick 15-minute call this week?\n\nBest,\n{{sender_name}}",
    baseDelayHours: 0,
    delayIntervalMinutes: 5,
    jiggleMinutes: 8,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
  };
  const smsAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "sms",
    messageBody:
      "Hi {{first_name}}, this is {{sender_name}} from Emerald Recruiting. I sent you an email about a role — let me know if you'd like to chat.",
    baseDelayHours: 2,
    delayIntervalMinutes: 0,
    jiggleMinutes: 10,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
  };
  const connectionAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "linkedin_connection",
    messageBody: "Hi {{first_name}}, would love to connect about a role I think you'd be interested in.",
    baseDelayHours: 0,
    delayIntervalMinutes: 0,
    jiggleMinutes: 8,
    postConnectionHardcodedHours: 4,
    respectSendWindow: false,
  };
  const linkedinMessageAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "linkedin_message",
    messageBody:
      "Hi {{first_name}}, thanks for connecting! I'm working on {{job_name}} and thought your background was a strong match. Interested in hearing more?",
    baseDelayHours: 0,
    delayIntervalMinutes: 0,
    jiggleMinutes: 10,
    postConnectionHardcodedHours: 4,
    respectSendWindow: true,
  };

  return {
    nodes: [
      {
        id: "node-1",
        type: "actionNode",
        position: { x: 50, y: 50 },
        data: {
          label: "1. Initial Outreach (InMail + Email + SMS)",
          actions: [inmailAction, emailAction, smsAction],
          nodeOrder: 1,
        },
      },
      {
        id: "node-2",
        type: "actionNode",
        position: { x: 50, y: 280 },
        data: {
          label: "2. Connection Request",
          actions: [connectionAction],
          nodeOrder: 2,
        },
      },
      {
        id: "node-3",
        type: "actionNode",
        position: { x: 50, y: 460 },
        data: {
          label: "3. LinkedIn Message (after 4h+)",
          actions: [linkedinMessageAction],
          nodeOrder: 3,
          isAfterConnection: true,
        },
      },
      {
        id: "node-end",
        type: "endNode",
        position: { x: 50, y: 680 },
        data: { label: "End" },
      },
    ],
    edges: [
      {
        id: "e1-2",
        source: "node-1",
        target: "node-2",
        label: "No response · 1 day",
        data: { condition: "no_response", afterDays: 1 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      },
      {
        id: "e2-3",
        source: "node-2",
        target: "node-3",
        label: "Connection accepted",
        data: { condition: "connection_accepted" },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2, stroke: "#22c55e" },
      },
      {
        id: "e2-end",
        source: "node-2",
        target: "node-end",
        label: "Not accepted · 7 days",
        data: { condition: "connection_not_accepted", afterDays: 7 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2, stroke: "#94a3b8" },
      },
      {
        id: "e3-end",
        source: "node-3",
        target: "node-end",
        label: "No response · 3 days",
        data: { condition: "no_response", afterDays: 3 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FlowBuilder({ initialNodes, initialEdges, onChange, onAskJoe }: Props) {
  const defaultFlow = useMemo(() => createEmptyFlow(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(defaultFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultFlow.edges);
  const [nodeCounter, setNodeCounter] = useState(2);

  const nodeTypes = useMemo(
    () => ({
      actionNode: ActionNode,
      waitNode: WaitNode,
      branchNode: BranchNode,
      endNode: EndNode,
    }),
    [],
  );

  // Wire up onUpdate handlers for any node that doesn't have them
  // (initial default nodes don't have callbacks wired to state)
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.type === "actionNode" && !(n.data as any).onUpdate) {
          return {
            ...n,
            data: {
              ...n.data,
              onUpdate: (actions: ActionData[]) => {
                setNodes((nds2) =>
                  nds2.map((nn) => (nn.id === n.id ? { ...nn, data: { ...nn.data, actions } } : nn)),
                );
              },
              onAskJoe: onAskJoe ? (actionIndex: number) => onAskJoe(n.id, actionIndex) : undefined,
            },
          };
        }
        if (n.type === "waitNode" && !(n.data as any).onUpdate) {
          return {
            ...n,
            data: {
              ...n.data,
              onUpdate: (waitDays: number) => {
                setNodes((nds2) =>
                  nds2.map((nn) => (nn.id === n.id ? { ...nn, data: { ...nn.data, waitDays } } : nn)),
                );
              },
            },
          };
        }
        if (n.type === "branchNode" && !(n.data as any).onUpdate) {
          return {
            ...n,
            data: {
              ...n.data,
              onUpdate: (condition: string, afterDays: number | null) => {
                setNodes((nds2) =>
                  nds2.map((nn) =>
                    nn.id === n.id ? { ...nn, data: { ...nn.data, condition, afterDays } } : nn,
                  ),
                );
              },
            },
          };
        }
        return n;
      }),
    );
  }, []); // run once on mount

  const onConnect = useCallback(
    (connection: Connection) => {
      const edge: Edge = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
        label: "No response · 3 days",
        data: { condition: "no_response", afterDays: 3 },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      } as Edge;
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges],
  );

  // Emit changes whenever nodes or edges change — this is what tells the parent
  // what to save. Without this, the Review panel sees empty state.
  useEffect(() => {
    if (!onChange) return;
    const flowNodes: FlowNodeData[] = nodes.map((n, i) => ({
      id: n.id,
      type:
        n.type === "actionNode"
          ? "action"
          : n.type === "waitNode"
            ? "wait"
            : n.type === "branchNode"
              ? "branch"
              : "end",
      label: (n.data as any).label || "",
      actions: (n.data as any).actions,
      waitDays: (n.data as any).waitDays,
      condition: (n.data as any).condition,
      afterDays: (n.data as any).afterDays,
      nodeOrder: i + 1,
    }));
    const flowEdges: FlowEdgeData[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
      condition: (e.data as any)?.condition,
      afterDays: (e.data as any)?.afterDays,
    }));
    onChange(flowNodes, flowEdges);
  }, [nodes, edges, onChange]);

  const loadIdealTemplate = useCallback(() => {
    const template = createIdealTemplate();
    setNodes(template.nodes);
    setEdges(template.edges);
    setNodeCounter(template.nodes.length + 1);
  }, [setNodes, setEdges]);

  const addNode = useCallback(
    (type: "action" | "wait" | "branch" | "end") => {
      const id = `node-${nodeCounter + 1}`;
      setNodeCounter((c) => c + 1);

      // Position below existing nodes
      const maxY = Math.max(...nodes.map((n) => n.position.y), 0);

      let newNode: Node;
      switch (type) {
        case "action":
          newNode = {
            id,
            type: "actionNode",
            position: { x: 250, y: maxY + 220 },
            data: {
              label: `Step ${nodeCounter + 1}`,
              actions: [
                {
                  id: crypto.randomUUID(),
                  channel: "email",
                  messageBody: "",
                  baseDelayHours: 24,
                  delayIntervalMinutes: 0,
                  jiggleMinutes: 10,
                  postConnectionHardcodedHours: 4,
                  respectSendWindow: true,
                },
              ],
              nodeOrder: nodeCounter + 1,
              onUpdate: (actions: ActionData[]) => {
                setNodes((nds) =>
                  nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, actions } } : n)),
                );
              },
              onAskJoe: onAskJoe ? (actionIndex: number) => onAskJoe(id, actionIndex) : undefined,
            },
          };
          break;
        case "wait":
          newNode = {
            id,
            type: "waitNode",
            position: { x: 275, y: maxY + 220 },
            data: {
              label: "Wait",
              waitDays: 3,
              onUpdate: (waitDays: number) => {
                setNodes((nds) =>
                  nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, waitDays } } : n)),
                );
              },
            },
          };
          break;
        case "branch":
          newNode = {
            id,
            type: "branchNode",
            position: { x: 275, y: maxY + 220 },
            data: {
              label: "Branch",
              condition: "no_response",
              afterDays: 3,
              onUpdate: (condition: string, afterDays: number | null) => {
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === id ? { ...n, data: { ...n.data, condition, afterDays } } : n,
                  ),
                );
              },
            },
          };
          break;
        case "end":
          newNode = {
            id,
            type: "endNode",
            position: { x: 300, y: maxY + 220 },
            data: { label: "End" },
          };
          break;
      }

      setNodes((nds) => [...nds, newNode]);
    },
    [nodeCounter, nodes, setNodes, onAskJoe],
  );

  return (
    <div className="h-[600px] border rounded-lg overflow-hidden relative">
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex gap-2 bg-white/90 backdrop-blur p-2 rounded-md shadow-sm border">
        <Button variant="default" size="sm" onClick={loadIdealTemplate} title="Load the ideal outreach sequence">
          <Wand2 className="h-3 w-3 mr-1" /> Quick Template
        </Button>
        <div className="w-px bg-border mx-1" />
        <Button variant="outline" size="sm" onClick={() => addNode("action")}>
          <Zap className="h-3 w-3 mr-1" /> Action
        </Button>
        <Button variant="outline" size="sm" onClick={() => addNode("wait")}>
          <Clock className="h-3 w-3 mr-1" /> Wait
        </Button>
        <Button variant="outline" size="sm" onClick={() => addNode("branch")}>
          <GitBranch className="h-3 w-3 mr-1" /> Branch
        </Button>
        <Button variant="outline" size="sm" onClick={() => addNode("end")}>
          <StopCircle className="h-3 w-3 mr-1" /> End
        </Button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={["Backspace", "Delete"]}
        defaultEdgeOptions={{
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: 2 },
        }}
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute bottom-3 right-3 z-10 bg-white/90 backdrop-blur p-2 rounded-md shadow-sm border text-[10px] text-muted-foreground space-y-1 max-w-[280px]">
        <p className="font-medium text-foreground">Engine rules (automatic):</p>
        <p>• Any reply on any channel → stop + Joe sentiment</p>
        <p>• Connection accepted ≠ reply (does NOT stop)</p>
        <p>• Calendar booked → stop</p>
        <p>• LinkedIn message requires connection (skipped otherwise)</p>
        <p>• Email skipped if no email on record</p>
        <p>• SMS skipped if no phone on record</p>
      </div>
    </div>
  );
}
