import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { SequenceStepCard } from "./SequenceStepCard";

export interface ActionData {
  id: string;
  channel: string;
  messageBody: string;
  baseDelayHours: number;
  delayIntervalMinutes: number;
  jiggleMinutes: number;
  postConnectionHardcodedHours: number;
  respectSendWindow: boolean;
  useSignature?: boolean;
}

interface ActionNodeData {
  label: string;
  actions: ActionData[];
  stepNumber?: number;
  onUpdate: (actions: ActionData[]) => void;
  onAskJoe?: (actionIndex: number, action: ActionData, stepNumber: number, stepLabel: string) => Promise<string>;
  isAfterConnection?: boolean;
}

function ActionNodeComponent({ data }: NodeProps<ActionNodeData>) {
  const { actions, onUpdate, onAskJoe, label, stepNumber } = data;

  return (
    <div className="min-w-[320px] max-w-[400px]">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <SequenceStepCard
        label={label}
        actions={actions}
        stepNumber={stepNumber}
        onUpdate={onUpdate}
        onAskJoe={onAskJoe}
      />
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

export const ActionNode = memo(ActionNodeComponent);
