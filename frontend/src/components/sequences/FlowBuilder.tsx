import { useCallback, useMemo, useState } from "react";
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
import { Plus, GitBranch, Clock, StopCircle, Zap } from "lucide-react";

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
// Default starting flow
// ─────────────────────────────────────────────────────────────────────────────

function createDefaultFlow(): { nodes: Node[]; edges: Edge[] } {
  const startAction: ActionData = {
    id: crypto.randomUUID(),
    channel: "linkedin_connection",
    messageBody: "Hi {{first_name}}, I'd love to connect regarding an opportunity I think you'd be great for.",
    baseDelayHours: 0,
    delayIntervalMinutes: 0,
    jiggleMinutes: 15,
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
          label: "Step 1: Connect",
          actions: [startAction],
          nodeOrder: 1,
          onUpdate: () => {},
        },
      },
      {
        id: "node-end",
        type: "endNode",
        position: { x: 275, y: 300 },
        data: { label: "End" },
      },
    ],
    edges: [
      {
        id: "edge-1-end",
        source: "node-1",
        target: "node-end",
        label: "No response (3 days)",
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
  const defaultFlow = useMemo(() => createDefaultFlow(), []);
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

  const onConnect = useCallback(
    (connection: Connection) => {
      const edge: Edge = {
        ...connection,
        id: `edge-${connection.source}-${connection.target}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
      } as Edge;
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges],
  );

  // Notify parent of changes
  const emitChange = useCallback(() => {
    if (!onChange) return;
    const flowNodes: FlowNodeData[] = nodes.map((n, i) => ({
      id: n.id,
      type: n.type === "actionNode" ? "action" : n.type === "waitNode" ? "wait" : n.type === "branchNode" ? "branch" : "end",
      label: n.data.label || "",
      actions: n.data.actions,
      waitDays: n.data.waitDays,
      condition: n.data.condition,
      afterDays: n.data.afterDays,
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
            position: { x: 250, y: maxY + 150 },
            data: {
              label: `Step ${nodeCounter + 1}`,
              actions: [
                {
                  id: crypto.randomUUID(),
                  channel: "email",
                  messageBody: "",
                  baseDelayHours: 24,
                  delayIntervalMinutes: 0,
                  jiggleMinutes: 15,
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
            position: { x: 275, y: maxY + 150 },
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
            position: { x: 275, y: maxY + 150 },
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
            position: { x: 300, y: maxY + 150 },
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
      <div className="absolute bottom-3 right-3 z-10 bg-white/90 backdrop-blur p-2 rounded-md shadow-sm border text-[10px] text-muted-foreground space-y-1">
        <p>Any reply on any channel = auto-stop + Joe sentiment</p>
        <p>Connection accepted = does NOT trigger stop</p>
        <p>Calendar booked = auto-stop</p>
      </div>
    </div>
  );
}
