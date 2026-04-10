import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Clock } from "lucide-react";

interface WaitNodeData {
  label: string;
  waitDays: number;
  onUpdate: (waitDays: number) => void;
}

function WaitNodeComponent({ data }: NodeProps<WaitNodeData>) {
  return (
    <div className="min-w-[200px]">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <Card className="shadow-md border-amber-200 bg-amber-50">
        <CardContent className="p-3 flex items-center gap-3">
          <Clock className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="space-y-1 flex-1">
            <Label className="text-xs">{data.label || "Wait"}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={data.waitDays}
                onChange={(e) => data.onUpdate(Number(e.target.value))}
                className="h-7 text-xs w-16"
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

export const WaitNode = memo(WaitNodeComponent);
