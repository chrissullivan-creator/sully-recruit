import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invalidateSendOutScope } from '@/lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';

/**
 * Read + edit the `submittal_notes` for a single send_out. Used from
 * the sendouts pipeline table, candidate-detail sendout cards, and the
 * job-detail Kanban so a recruiter can update notes without leaving
 * the surface they're working on.
 *
 * The component owns its own state + persistence: it pulls the latest
 * `submittal_notes` whenever it opens (so a stale prop doesn't
 * overwrite a fresh edit somewhere else), saves on Save, and
 * invalidates send-out queries so other surfaces refresh.
 *
 * Sibling to `SendOutNotesDialog` (which is a write-only collector
 * used at stage-move time). Kept distinct because that one is "dumb"
 * by design and we don't want to fold reads into it.
 */
export function EditSendOutNotesDialog({
  open,
  onOpenChange,
  sendOutId,
  candidateName,
  jobTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sendOutId: string | null;
  candidateName?: string | null;
  jobTitle?: string | null;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pull fresh notes every time the dialog opens. Avoids stale-prop
  // drift if the row got edited from a different surface mid-session.
  useEffect(() => {
    if (!open || !sendOutId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('send_outs')
      .select('submittal_notes')
      .eq('id', sendOutId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          toast({ title: 'Could not load notes', description: error.message, variant: 'destructive' });
          setNote('');
          setOriginal('');
        } else {
          const v = (data as any)?.submittal_notes ?? '';
          setNote(v);
          setOriginal(v);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, sendOutId]);

  const handleSave = async () => {
    if (!sendOutId) return;
    setSaving(true);
    const { error } = await supabase
      .from('send_outs')
      .update({ submittal_notes: note })
      .eq('id', sendOutId);
    setSaving(false);
    if (error) {
      toast({ title: 'Could not save notes', description: error.message, variant: 'destructive' });
      return;
    }
    invalidateSendOutScope(qc);
    toast({ title: 'Notes saved' });
    onOpenChange(false);
  };

  const subject = candidateName && jobTitle
    ? `${candidateName} → ${jobTitle}`
    : candidateName || jobTitle || '';

  const dirty = note !== original;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send-out notes</DialogTitle>
          <DialogDescription>
            {subject
              ? <>Edit the notes for <span className="font-medium">{subject}</span>.</>
              : <>Edit the notes attached to this send-out.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="edit-send-out-note" className="text-xs uppercase tracking-wide text-muted-foreground">
            Notes
          </Label>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <Textarea
              id="edit-send-out-note"
              autoFocus
              rows={6}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this candidate, what to flag for the client, comp expectations…"
              className="resize-y"
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} type="button">
            Cancel
          </Button>
          <Button variant="gold" onClick={handleSave} disabled={saving || loading || !dirty} type="button">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Save notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
