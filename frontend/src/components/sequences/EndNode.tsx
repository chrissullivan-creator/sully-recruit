import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Card, CardContent } from "@/components/ui/card";
import { StopCircle } from "lucide-react";

type EndNodeData = { label: string } & Record<string, unknown>;
type EndNodeType = Node<EndNodeData, "end">;

function EndNodeComponent({ data }: NodeProps<EndNodeType>) {
  return (
    <div className="min-w-[150px]">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <Card className="shadow-md border-red-200 bg-red-50">
        <CardContent className="p-3 flex items-center gap-2 justify-center">
          <StopCircle className="h-4 w-4 text-red-600" />
          <span className="text-sm font-medium text-red-800">{data.label || "End"}</span>
        </CardContent>
      </Card>
    </div>
  );
}

export const EndNode = memo(EndNodeComponent);
