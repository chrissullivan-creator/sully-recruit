import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { EndNode } from "./EndNode";
import { Button } from "@/components/ui/button";
import { StopCircle, Zap, Wand2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types for serialization
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowNodeData {
  id: string;
  type: "action" | "end";
  label: string;
  actions?: ActionData[];
  nodeOrder: number;
}

export interface FlowEdgeData {
  id: string;
  source: string;
  target: string;
}

interface Props {
  onChange?: (nodes: FlowNodeData[], edges: FlowEdgeData[]) => void;
  onAskJoe?: (
    action: ActionData,
    stepNumber: number,
    stepLabel: string,
    previousMessages: Array<{ channel: string; body: string }>,
  ) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default starting flow
// ─────────────────────────────────────────────────────────────────────────────

function createEmptyFlow(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: "node-1",
        type: "actionNode",
        position: { x: 150, y: 50 },
        data: {
          label: "",
          actions: [
            {
              id: crypto.randomUUID(),
              channel: "linkedin_inmail",
              messageBody: "",
              baseDelayHours: 0,
              delayIntervalMinutes: 0,
              jiggleMinutes: 5,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
          ],
          nodeOrder: 1,
        },
      },
      {
        id: "node-end",
        type: "endNode",
        position: { x: 225, y: 300 },
        data: { label: "End" },
      },
    ],
    edges: [
      {
        id: "e1-end",
        source: "node-1",
        target: "node-end",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2, stroke: "#94a3b8" },
      },
    ],
  };
}

/**
 * Quick-start template — flat multi-channel outreach:
 *   Node 1: InMail + Connection + Email + LinkedIn message (pending) + SMS
 *   Node 2: Follow-up email (24h window-hours later)
 *   End
 *
 * All actions pre-scheduled at enrollment. LinkedIn message parks until connected.
 * Reply on any channel = auto-stop.
 */
function createIdealTemplate(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: "node-1",
        type: "actionNode",
        position: { x: 50, y: 50 },
        data: {
          label: "Multi-channel outreach",
          actions: [
            {
              id: crypto.randomUUID(),
              channel: "linkedin_inmail",
              messageBody: "Hi {{first_name}}, I'm {{sender_name}} at Emerald Recruiting. I came across your profile and think you'd be a great fit for {{job_name}}. Open to a quick chat?",
              baseDelayHours: 0,
              delayIntervalMinutes: 0,
              jiggleMinutes: 5,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
            {
              id: crypto.randomUUID(),
              channel: "linkedin_connection",
              messageBody: "Hi {{first_name}}, would love to connect about a role I think you'd be interested in.",
              baseDelayHours: 0,
              delayIntervalMinutes: 0,
              jiggleMinutes: 8,
              postConnectionHardcodedHours: 4,
              respectSendWindow: false,
            },
            {
              id: crypto.randomUUID(),
              channel: "email",
              messageBody: "Hi {{first_name}},\n\nI'm {{sender_name}} at Emerald Recruiting. I'm working on {{job_name}} and think your background is a strong match.\n\nWould you be open to a quick 15-minute call this week?\n\nBest,\n{{sender_name}}",
              baseDelayHours: 0,
              delayIntervalMinutes: 5,
              jiggleMinutes: 8,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
            {
              id: crypto.randomUUID(),
              channel: "linkedin_message",
              messageBody: "Hi {{first_name}}, thanks for connecting! I'm working on {{job_name}} and thought your background was a strong match. Interested in hearing more?",
              baseDelayHours: 0,
              delayIntervalMinutes: 0,
              jiggleMinutes: 10,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
            {
              id: crypto.randomUUID(),
              channel: "sms",
              messageBody: "Hi {{first_name}}, this is {{sender_name}} from Emerald Recruiting. I sent you an email about a role — let me know if you'd like to chat.",
              baseDelayHours: 2,
              delayIntervalMinutes: 0,
              jiggleMinutes: 10,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
          ],
          nodeOrder: 1,
        },
      },
      {
        id: "node-2",
        type: "actionNode",
        position: { x: 50, y: 400 },
        data: {
          label: "Follow-up email",
          actions: [
            {
              id: crypto.randomUUID(),
              channel: "email",
              messageBody: "Hi {{first_name}},\n\nJust following up on my earlier note about {{job_name}}. Would love to chat if you're open to it.\n\nBest,\n{{sender_name}}",
              baseDelayHours: 24,
              delayIntervalMinutes: 0,
              jiggleMinutes: 15,
              postConnectionHardcodedHours: 4,
              respectSendWindow: true,
            },
          ],
          nodeOrder: 2,
        },
      },
      {
        id: "node-end",
        type: "endNode",
        position: { x: 150, y: 600 },
        data: { label: "End" },
      },
    ],
    edges: [
      {
        id: "e1-2",
        source: "node-1",
        target: "node-2",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2, stroke: "#94a3b8" },
      },
      {
        id: "e2-end",
        source: "node-2",
        target: "node-end",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2, stroke: "#94a3b8" },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FlowBuilder({ onChange, onAskJoe }: Props) {
  const defaultFlow = useMemo(() => createEmptyFlow(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(defaultFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultFlow.edges);
  const [nodeCounter, setNodeCounter] = useState(2);

  const onAskJoeRef = useRef(onAskJoe);
  useEffect(() => { onAskJoeRef.current = onAskJoe; }, [onAskJoe]);

  const nodeTypes = useMemo(() => ({ actionNode: ActionNode, endNode: EndNode }), []);

  const buildAskJoeHandler = useCallback((nodeId: string) => {
    return async (_actionIndex: number, action: ActionData, stepNumber: number, stepLabel: string): Promise<string> => {
      const handler = onAskJoeRef.current;
      if (!handler) return "";
      const previousMessages: Array<{ channel: string; body: string }> = [];
      setNodes((nds) => {
        const actionNodes = nds.filter((n) => n.type === "actionNode");
        const currentIdx = actionNodes.findIndex((n) => n.id === nodeId);
        for (let i = 0; i < currentIdx; i++) {
          for (const a of ((actionNodes[i].data as any).actions || [])) {
            if (a.messageBody) previousMessages.push({ channel: a.channel, body: a.messageBody });
          }
        }
        return nds;
      });
      return handler(action, stepNumber, stepLabel, previousMessages);
    };
  }, [setNodes]);

  // Wire handlers on mount
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.type === "actionNode" && !(n.data as any).onUpdate) {
          return {
            ...n,
            data: {
              ...n.data,
              onUpdate: (actions: ActionData[]) => {
                setNodes((nds2) => nds2.map((nn) => (nn.id === n.id ? { ...nn, data: { ...nn.data, actions } } : nn)));
              },
              onAskJoe: buildAskJoeHandler(n.id),
            },
          };
        }
        return n;
      }),
    );
  }, []);

  // Auto-renumber action nodes
  useEffect(() => {
    setNodes((nds) => {
      let stepCounter = 0;
      let changed = false;
      const updated = nds.map((n) => {
        if (n.type !== "actionNode") return n;
        stepCounter++;
        const currentStep = (n.data as any).stepNumber;
        const currentLabel = (n.data as any).label || "";
        const isDefaultLabel = /^Step \d+$/.test(currentLabel);
        const newLabel = isDefaultLabel ? "" : currentLabel;
        if (currentStep !== stepCounter || currentLabel !== newLabel) {
          changed = true;
          return { ...n, data: { ...n.data, stepNumber: stepCounter, label: newLabel } };
        }
        return n;
      });
      return changed ? updated : nds;
    });
  }, [nodes.length, nodes.map((n) => n.id).join(",")]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { strokeWidth: 2, stroke: "#94a3b8" },
          } as Edge,
          eds,
        ),
      );
    },
    [setEdges],
  );

  // Emit changes to parent
  useEffect(() => {
    if (!onChange) return;
    const flowNodes: FlowNodeData[] = nodes.map((n, i) => ({
      id: n.id,
      type: n.type === "actionNode" ? "action" as const : "end" as const,
      label: (n.data as any).label || "",
      actions: (n.data as any).actions,
      nodeOrder: i + 1,
    }));
    const flowEdges: FlowEdgeData[] = edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
    onChange(flowNodes, flowEdges);
  }, [nodes, edges, onChange]);

  const loadIdealTemplate = useCallback(() => {
    const template = createIdealTemplate();
    setNodes(template.nodes);
    setEdges(template.edges);
    setNodeCounter(template.nodes.length + 1);
  }, [setNodes, setEdges]);

  const addNode = useCallback(
    (type: "action" | "end") => {
      const id = `node-${nodeCounter + 1}`;
      setNodeCounter((c) => c + 1);
      const maxY = Math.max(...nodes.map((n) => n.position.y), 0);

      const newNode: Node =
        type === "action"
          ? {
              id,
              type: "actionNode",
              position: { x: 150, y: maxY + 220 },
              data: {
                label: "",
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
                  setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, actions } } : n)));
                },
                onAskJoe: buildAskJoeHandler(id),
              },
            }
          : {
              id,
              type: "endNode",
              position: { x: 225, y: maxY + 220 },
              data: { label: "End" },
            };

      setNodes((nds) => [...nds, newNode]);
    },
    [nodeCounter, nodes, setNodes, buildAskJoeHandler],
  );

  return (
    <div className="h-[600px] border rounded-lg overflow-hidden relative">
      <div className="absolute top-3 left-3 z-10 flex gap-2 bg-white/90 backdrop-blur p-2 rounded-md shadow-sm border">
        <Button variant="default" size="sm" onClick={loadIdealTemplate} title="Load the ideal outreach sequence">
          <Wand2 className="h-3 w-3 mr-1" /> Quick Template
        </Button>
        <div className="w-px bg-border mx-1" />
        <Button variant="outline" size="sm" onClick={() => addNode("action")}>
          <Zap className="h-3 w-3 mr-1" /> Action
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
          style: { strokeWidth: 2, stroke: "#94a3b8" },
        }}
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>

      <div className="absolute bottom-3 right-3 z-10 bg-white/90 backdrop-blur p-2 rounded-md shadow-sm border text-[10px] text-muted-foreground space-y-1 max-w-[280px]">
        <p className="font-medium text-foreground">Engine rules (automatic):</p>
        <p>&#8226; Any reply on any channel stops the sequence + Joe sentiment</p>
        <p>&#8226; Connection accepted does NOT stop (triggers LinkedIn message)</p>
        <p>&#8226; Calendar booked stops the sequence</p>
        <p>&#8226; LinkedIn message waits for connection (4h min, window-hours)</p>
        <p>&#8226; Email/SMS skipped if no email/phone on record</p>
        <p>&#8226; Delay hours count only within send window</p>
      </div>
    </div>
  );
}
