import { useCallback, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { Sparkles, Loader2, Mail, Linkedin, MessageSquare, Phone } from "lucide-react";

const MERGE_TAGS = [
  "{{first_name}}", "{{last_name}}", "{{company}}", "{{title}}", "{{job_name}}", "{{sender_name}}",
];

const CHANNEL_INFO: Record<string, { label: string; icon: typeof Mail; color: string }> = {
  linkedin_connection: { label: "LinkedIn Connection", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  linkedin_message: { label: "LinkedIn Message", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  linkedin_inmail: { label: "LinkedIn InMail", icon: Linkedin, color: "bg-indigo-100 text-indigo-800" },
  email: { label: "Email", icon: Mail, color: "bg-green-100 text-green-800" },
  sms: { label: "SMS", icon: MessageSquare, color: "bg-yellow-100 text-yellow-800" },
  manual_call: { label: "Manual Call", icon: Phone, color: "bg-orange-100 text-orange-800" },
};

interface StepEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: string;
  messageBody: string;
  onMessageChange: (body: string) => void;
  stepNumber?: number;
  stepLabel?: string;
  onAskJoe?: () => Promise<void>;
  askJoeLoading?: boolean;
}

export function StepEditorDialog({
  open,
  onOpenChange,
  channel,
  messageBody,
  onMessageChange,
  stepNumber,
  stepLabel,
  onAskJoe,
  askJoeLoading,
}: StepEditorDialogProps) {
  const info = CHANNEL_INFO[channel] || CHANNEL_INFO.email;
  const Icon = info.icon;

  const insertTag = useCallback((tag: string) => {
    // For rich text, append the tag — the editor handles cursor positioning
    onMessageChange(messageBody + tag);
  }, [messageBody, onMessageChange]);

  const charLimit = channel === "linkedin_connection" ? 300 : channel === "sms" ? 160 : undefined;
  const plainLength = messageBody.replace(/<[^>]*>/g, "").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            <span>
              {stepNumber ? `Step ${stepNumber}` : "Edit Message"}
              {stepLabel ? `: ${stepLabel}` : ""}
            </span>
            <Badge className={`${info.color} text-xs ml-1`}>{info.label}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 space-y-3 overflow-y-auto">
          {/* Merge tags */}
          <div className="flex flex-wrap gap-1">
            <span className="text-xs text-muted-foreground mr-1 self-center">Insert:</span>
            {MERGE_TAGS.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="cursor-pointer text-xs hover:bg-slate-200"
                onClick={() => insertTag(tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>

          {/* Rich text editor */}
          <RichTextEditor
            value={messageBody}
            onChange={onMessageChange}
            placeholder={`Write your ${info.label.toLowerCase()} message...`}
            minHeight="250px"
          />

          {/* Character count for limited channels */}
          {charLimit && (
            <p className={`text-xs ${plainLength > charLimit ? "text-destructive" : "text-muted-foreground"}`}>
              {plainLength} / {charLimit} characters
              {plainLength > charLimit && " — over limit!"}
            </p>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div>
            {onAskJoe && (
              <Button
                variant="outline"
                size="sm"
                onClick={onAskJoe}
                disabled={askJoeLoading}
              >
                {askJoeLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                )}
                Ask Joe
              </Button>
            )}
          </div>
          <Button variant="gold" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
