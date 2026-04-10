import { memo, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Plus, Trash2, Mail, MessageSquare, Phone, Linkedin } from "lucide-react";

const CHANNELS = [
  { value: "linkedin_connection", label: "LinkedIn Connection", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  { value: "linkedin_message", label: "LinkedIn Message", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  { value: "linkedin_inmail", label: "LinkedIn InMail", icon: Linkedin, color: "bg-indigo-100 text-indigo-800" },
  { value: "email", label: "Email", icon: Mail, color: "bg-green-100 text-green-800" },
  { value: "sms", label: "SMS", icon: MessageSquare, color: "bg-yellow-100 text-yellow-800" },
  { value: "manual_call", label: "Manual Call", icon: Phone, color: "bg-orange-100 text-orange-800" },
];

const DELAY_OPTIONS = Array.from({ length: 13 }, (_, i) => i * 10); // 0, 10, 20, ... 120

const MERGE_TAGS = [
  "{{first_name}}", "{{last_name}}", "{{company}}", "{{title}}", "{{job_name}}", "{{sender_name}}",
];

export interface ActionData {
  id: string;
  channel: string;
  messageBody: string;
  baseDelayHours: number;
  delayIntervalMinutes: number;
  jiggleMinutes: number;
  postConnectionHardcodedHours: number;
  respectSendWindow: boolean;
}

interface ActionNodeData {
  label: string;
  actions: ActionData[];
  onUpdate: (actions: ActionData[]) => void;
  onAskJoe?: (actionIndex: number) => void;
  isAfterConnection?: boolean;
}

function ActionNodeComponent({ data }: NodeProps<ActionNodeData>) {
  const { actions, onUpdate, onAskJoe, label } = data;

  const updateAction = useCallback(
    (index: number, field: keyof ActionData, value: any) => {
      const updated = [...actions];
      updated[index] = { ...updated[index], [field]: value };
      onUpdate(updated);
    },
    [actions, onUpdate],
  );

  const addAction = useCallback(() => {
    onUpdate([
      ...actions,
      {
        id: crypto.randomUUID(),
        channel: "email",
        messageBody: "",
        baseDelayHours: 0,
        delayIntervalMinutes: 0,
        jiggleMinutes: 15,
        postConnectionHardcodedHours: 4,
        respectSendWindow: true,
      },
    ]);
  }, [actions, onUpdate]);

  const removeAction = useCallback(
    (index: number) => {
      onUpdate(actions.filter((_, i) => i !== index));
    },
    [actions, onUpdate],
  );

  const insertTag = useCallback(
    (index: number, tag: string) => {
      const current = actions[index].messageBody || "";
      updateAction(index, "messageBody", current + tag);
    },
    [actions, updateAction],
  );

  return (
    <div className="min-w-[320px] max-w-[400px]">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <Card className="shadow-md border-slate-200">
        <CardHeader className="py-2 px-3 flex flex-row items-center justify-between">
          <span className="text-sm font-medium">{label || "Action"}</span>
          <Button variant="ghost" size="sm" onClick={addAction}>
            <Plus className="h-3 w-3 mr-1" /> Add Channel
          </Button>
        </CardHeader>
        <CardContent className="p-3 space-y-3">
          {actions.map((action, i) => {
            const channelInfo = CHANNELS.find((c) => c.value === action.channel);
            const Icon = channelInfo?.icon || Mail;

            return (
              <div key={action.id} className="border rounded-md p-3 space-y-2 bg-slate-50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4" />
                    <Select
                      value={action.channel}
                      onValueChange={(v) => updateAction(i, "channel", v)}
                    >
                      <SelectTrigger className="w-[180px] h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHANNELS.map((ch) => (
                          <SelectItem key={ch.value} value={ch.value}>
                            {ch.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-1">
                    {onAskJoe && (
                      <Button variant="ghost" size="sm" onClick={() => onAskJoe(i)} className="h-7 px-2">
                        <Sparkles className="h-3 w-3" />
                      </Button>
                    )}
                    {actions.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => removeAction(i)} className="h-7 px-2 text-destructive">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>

                {action.channel !== "manual_call" && (
                  <>
                    <Textarea
                      value={action.messageBody}
                      onChange={(e) => updateAction(i, "messageBody", e.target.value)}
                      placeholder="Message body..."
                      rows={3}
                      className="text-xs"
                    />
                    <div className="flex flex-wrap gap-1">
                      {MERGE_TAGS.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="cursor-pointer text-[10px] hover:bg-slate-200"
                          onClick={() => insertTag(i, tag)}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}

                {/* Timing */}
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-[10px]">Base delay (hrs)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={action.baseDelayHours}
                      onChange={(e) => updateAction(i, "baseDelayHours", Number(e.target.value))}
                      className="h-7 text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">+ delay (min)</Label>
                    <Select
                      value={String(action.delayIntervalMinutes)}
                      onValueChange={(v) => updateAction(i, "delayIntervalMinutes", Number(v))}
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DELAY_OPTIONS.map((d) => (
                          <SelectItem key={d} value={String(d)}>{d} min</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-[10px]">Jiggle ±</Label>
                    <Input
                      type="number"
                      min={0}
                      value={action.jiggleMinutes}
                      onChange={(e) => updateAction(i, "jiggleMinutes", Number(e.target.value))}
                      className="h-7 text-xs"
                    />
                  </div>
                </div>

                {/* Post-connection label for linkedin_message after connection */}
                {action.channel === "linkedin_message" && data.isAfterConnection && (
                  <p className="text-[10px] text-muted-foreground bg-blue-50 p-2 rounded">
                    4 hours minimum after connection accepted (required)
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

export const ActionNode = memo(ActionNodeComponent);
