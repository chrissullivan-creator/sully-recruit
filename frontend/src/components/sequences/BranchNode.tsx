import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitBranch } from "lucide-react";

const CONDITIONS = [
  { value: "no_response", label: "No response" },
  { value: "any_reply", label: "Any reply" },
  { value: "connection_accepted", label: "Connection accepted" },
  { value: "connection_not_accepted", label: "Connection not accepted" },
  { value: "calendar_booked", label: "Calendar booked" },
  { value: "end", label: "End sequence" },
];

interface BranchNodeData {
  label: string;
  condition: string;
  afterDays: number | null;
  onUpdate: (condition: string, afterDays: number | null) => void;
}

function BranchNodeComponent({ data }: NodeProps<BranchNodeData>) {
  const conditionInfo = CONDITIONS.find((c) => c.value === data.condition);

  return (
    <div className="min-w-[220px]">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <Card className="shadow-md border-purple-200 bg-purple-50">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-purple-600" />
            <span className="text-xs font-medium">{data.label || "Branch"}</span>
          </div>

          <Select
            value={data.condition}
            onValueChange={(v) => data.onUpdate(v, data.afterDays)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(data.condition === "no_response" || data.condition === "connection_not_accepted") && (
            <div className="flex items-center gap-2">
              <Label className="text-[10px] whitespace-nowrap">After</Label>
              <Input
                type="number"
                min={1}
                value={data.afterDays || 3}
                onChange={(e) => data.onUpdate(data.condition, Number(e.target.value))}
                className="h-7 text-xs w-16"
              />
              <span className="text-[10px] text-muted-foreground">days</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

export const BranchNode = memo(BranchNodeComponent);
