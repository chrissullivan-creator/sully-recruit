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
  /** Public URL of an attachment (résumé, branded PDF, etc.) the send
   *  path should attach to outgoing email or LinkedIn message. Stored on
   *  sequence_actions.attachment_url. */
  attachmentUrl?: string;
  /** Original filename — kept so the recipient sees a sensible name
   *  rather than a Storage hash. Optional. */
  attachmentName?: string;
  /** Email subject line. Empty for non-email channels. When
   *  reply_to_previous is on this is ignored and the previous sent
   *  step's subject is reused with "Re: " prefix. */
  subjectLine?: string;
  /** When true, send this email as a reply to the most recent sent
   *  email step in the same enrollment (In-Reply-To + References).
   *  Default off for the first step, on for follow-ups. */
  replyToPrevious?: boolean;
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
