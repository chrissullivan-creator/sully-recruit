import { useCallback, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RichTextEditor from "@/components/shared/RichTextEditor";
import { toast } from "sonner";
import { Sparkles, Plus, Trash2, Mail, MessageSquare, Phone, Linkedin, Loader2, Pencil, Paperclip, X } from "lucide-react";
import type { ActionData } from "./ActionNode";
import { supabase } from "@/integrations/supabase/client";

const CHANNELS = [
  { value: "linkedin_connection", label: "LinkedIn Connection", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  { value: "linkedin_message", label: "LinkedIn Message", icon: Linkedin, color: "bg-blue-100 text-blue-800" },
  { value: "linkedin_inmail", label: "LinkedIn Recruiter InMail", icon: Linkedin, color: "bg-indigo-100 text-indigo-800" },
  { value: "email", label: "Email", icon: Mail, color: "bg-green-100 text-green-800" },
  { value: "sms", label: "SMS", icon: MessageSquare, color: "bg-yellow-100 text-yellow-800" },
  { value: "manual_call", label: "Manual Call", icon: Phone, color: "bg-orange-100 text-orange-800" },
];

const DELAY_OPTIONS = Array.from({ length: 13 }, (_, i) => i * 10);

const MERGE_TAGS = [
  "{{first_name}}", "{{last_name}}", "{{company}}", "{{title}}", "{{job_name}}", "{{sender_name}}",
];

interface SequenceStepCardProps {
  label: string;
  actions: ActionData[];
  stepNumber?: number;
  title?: string;
  onUpdate: (actions: ActionData[]) => void;
  onAskJoe?: (actionIndex: number, action: ActionData, stepNumber: number, stepLabel: string) => Promise<string>;
}

export function SequenceStepCard({
  actions,
  onUpdate,
  onAskJoe,
  label,
  stepNumber,
  title,
}: SequenceStepCardProps) {
  const [loadingIndex, setLoadingIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editorDraft, setEditorDraft] = useState("");

  const updateAction = useCallback(
    (index: number, field: keyof ActionData, value: ActionData[keyof ActionData]) => {
      const updated = [...actions];
      updated[index] = { ...updated[index], [field]: value };
      onUpdate(updated);
    },
    [actions, onUpdate],
  );

  const handleAskJoe = useCallback(
    async (actionIndex: number) => {
      if (!onAskJoe) return;
      setLoadingIndex(actionIndex);
      try {
        const drafted = await onAskJoe(actionIndex, actions[actionIndex], stepNumber || 1, label || "");
        if (drafted) updateAction(actionIndex, "messageBody", drafted);
      } catch (err) {
        console.error("Ask Joe failed:", err);
      } finally {
        setLoadingIndex(null);
      }
    },
    [actions, label, onAskJoe, stepNumber, updateAction],
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
        useSignature: true,
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

  const editingAction = editingIndex === null ? null : actions[editingIndex];
  const editingChannelLabel = useMemo(
    () => CHANNELS.find((channel) => channel.value === editingAction?.channel)?.label || "Message",
    [editingAction],
  );
  const isRichTextChannel = editingAction?.channel === "email";

  const openEditor = useCallback((index: number) => {
    setEditorDraft(actions[index].messageBody || "");
    setEditingIndex(index);
  }, [actions]);

  const closeEditor = useCallback(() => {
    setEditingIndex(null);
    setEditorDraft("");
  }, []);

  const saveEditorDraft = useCallback(() => {
    if (editingIndex === null) return;
    updateAction(editingIndex, "messageBody", editorDraft);
    closeEditor();
  }, [closeEditor, editorDraft, editingIndex, updateAction]);

  const handleAskJoeInDialog = useCallback(async () => {
    if (editingIndex === null || !onAskJoe) return;
    setLoadingIndex(editingIndex);
    try {
      const drafted = await onAskJoe(editingIndex, actions[editingIndex], stepNumber || 1, label || "");
      if (drafted) setEditorDraft(drafted);
    } catch (err) {
      console.error("Ask Joe failed:", err);
    } finally {
      setLoadingIndex(null);
    }
  }, [actions, editingIndex, label, onAskJoe, stepNumber]);

  const copyMergeTag = useCallback(async (tag: string) => {
    try {
      await navigator.clipboard.writeText(tag);
      toast.success(`${tag} copied`);
    } catch {
      toast.error("Couldn't copy merge tag");
    }
  }, []);

  const cardTitle = title || `${stepNumber ? `Step ${stepNumber}` : ""}${label && label !== `Step ${stepNumber}` ? (stepNumber ? `: ${label}` : label) : ""}`;

  return (
    <Card className="shadow-sm border-slate-200 bg-white">
      <CardHeader className="py-2 px-3 flex flex-row items-center justify-between gap-3">
        <span className="text-sm font-medium">{cardTitle}</span>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAskJoe(i)}
                      className="h-7 px-2"
                      disabled={loadingIndex === i}
                      title="Ask Joe to draft this message"
                    >
                      {loadingIndex === i ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
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
                  <button
                    type="button"
                    onClick={() => openEditor(i)}
                    className="w-full rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-xs transition-colors hover:border-slate-400 hover:bg-slate-100"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">Edit message in larger window</span>
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Pencil className="h-3 w-3" />
                        Open editor
                      </span>
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                      {action.messageBody
                        ? action.messageBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
                        : "No message drafted yet."}
                    </p>
                  </button>
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

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-[10px]" title="Hours of delay counted within the send window (not calendar hours)">Delay (window hrs)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={action.baseDelayHours}
                    onChange={(e) => updateAction(i, "baseDelayHours", Number(e.target.value))}
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-[10px]" title="Additional minutes to add on top of base delay">+ delay (min)</Label>
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
                  <Label className="text-[10px]" title="Randomizes send time by ±N minutes (e.g. 5 = ±5 min random)">Random ± (min)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={action.jiggleMinutes}
                    onChange={(e) => updateAction(i, "jiggleMinutes", Number(e.target.value))}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              {action.channel === "email" && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`use-signature-${action.id}`}
                    checked={action.useSignature !== false}
                    onCheckedChange={(checked) => updateAction(i, "useSignature", !!checked)}
                  />
                  <Label htmlFor={`use-signature-${action.id}`} className="text-[11px] cursor-pointer">
                    Include email signature
                  </Label>
                </div>
              )}
              {(action.channel === "email"
                || action.channel === "linkedin_message"
                || action.channel === "linkedin_inmail") && (
                <AttachmentPicker
                  action={action}
                  onUpdate={(url, name) => {
                    updateAction(i, "attachmentUrl", url);
                    updateAction(i, "attachmentName", name);
                  }}
                />
              )}
              <p className="text-[9px] text-muted-foreground italic">
                {action.channel === "linkedin_connection"
                  ? "Connection requests send 24/7 (send window ignored)"
                  : action.channel === "linkedin_message"
                    ? "Sent only after LinkedIn connection is accepted (4h+ minimum)"
                    : action.channel === "email"
                      ? "Skipped if candidate has no email on record"
                      : action.channel === "sms"
                        ? "Skipped if candidate has no phone number"
                        : action.channel === "linkedin_inmail"
                          ? "InMail — respects send window, no connection required"
                          : null}
              </p>

              {action.channel === "linkedin_message" && (
                <p className="text-[10px] text-muted-foreground bg-blue-50 p-2 rounded">
                  Waits for connection + 4h minimum (window-hours). Delay field = additional hours on top of the 4h.
                </p>
              )}
            </div>
          );
        })}
      </CardContent>

      <Dialog open={editingIndex !== null} onOpenChange={(open) => !open && closeEditor()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {stepNumber ? `Step ${stepNumber}` : "Sequence Step"} Message Editor
            </DialogTitle>
            <DialogDescription>
              Draft and refine the {editingChannelLabel.toLowerCase()} copy in a larger workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {MERGE_TAGS.map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="cursor-pointer text-[10px] hover:bg-slate-100"
                  onClick={() => copyMergeTag(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>

            {isRichTextChannel ? (
              <RichTextEditor
                value={editorDraft}
                onChange={setEditorDraft}
                placeholder="Draft the message body..."
                minHeight="260px"
              />
            ) : (
              <Textarea
                value={editorDraft}
                onChange={(e) => setEditorDraft(e.target.value)}
                placeholder="Draft the message body..."
                rows={14}
                className="text-sm"
              />
            )}

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Merge tags copy to your clipboard so you can paste them where you want inside the message.
              </p>
              <div className="flex gap-2">
                {onAskJoe && (
                  <Button
                    variant="outline"
                    onClick={handleAskJoeInDialog}
                    disabled={editingIndex === null || loadingIndex === editingIndex}
                  >
                    {loadingIndex === editingIndex ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    Ask Joe
                  </Button>
                )}
                <Button variant="outline" onClick={closeEditor}>
                  Cancel
                </Button>
                <Button onClick={saveEditorDraft}>
                  Save Message
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Attachment picker for an email-channel action. Uploads to the
 * `sequence-attachments` Storage bucket under the user's id and stores
 * the resulting public URL on action.attachmentUrl. The send path
 * (lib/send-channels.ts:sendEmail) fetches that URL at send-time and
 * attaches the file to the outbound Microsoft Graph message.
 */
function AttachmentPicker({
  action,
  onUpdate,
}: {
  action: ActionData;
  onUpdate: (url: string | undefined, name: string | undefined) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${session.user.id}/${Date.now()}_${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("sequence-attachments")
        .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from("sequence-attachments").getPublicUrl(path);
      onUpdate(pub.publicUrl, file.name);
      toast.success("Attachment uploaded");
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  if (action.attachmentUrl) {
    return (
      <div className="flex items-center gap-2 rounded border border-emerald/30 bg-emerald-light/10 px-2 py-1.5">
        <Paperclip className="h-3.5 w-3.5 text-emerald-dark shrink-0" />
        <a
          href={action.attachmentUrl}
          target="_blank" rel="noopener noreferrer"
          className="text-[11px] text-emerald-dark hover:underline truncate flex-1"
          title={action.attachmentUrl}
        >
          {action.attachmentName || "Attachment"}
        </a>
        <button
          type="button"
          onClick={() => onUpdate(undefined, undefined)}
          className="text-muted-foreground hover:text-destructive"
          title="Remove attachment"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
      <Button
        type="button" variant="outline" size="sm"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
        className="h-7 text-[11px]"
      >
        {uploading ? (
          <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Uploading…</>
        ) : (
          <><Paperclip className="h-3 w-3 mr-1" /> Add attachment</>
        )}
      </Button>
    </div>
  );
}
