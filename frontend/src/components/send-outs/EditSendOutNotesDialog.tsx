import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { invalidateSendOutScope, invalidateNoteScope } from '@/lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/hooks/use-toast';

interface NoteHistoryRow {
  id: string;
  note: string;
  created_at: string;
  note_source: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  add_send_out: 'Added to job',
  stage_move: 'Stage move',
  submittal_edit: 'Notes edit',
};

/**
 * Read + edit notes for a single send_out. Surfaces both the live
 * `send_outs.submittal_notes` (editable) AND the chronological note
 * trail from the polymorphic `notes` table (entity_type='send_out').
 *
 * Behaviour:
 *  - On open, loads the send_out's submittal_notes plus its full note
 *    history. If submittal_notes is empty but a history row exists,
 *    pre-fills the textarea with the most-recent note so the recruiter
 *    can edit the original "added to job" pitch instead of starting
 *    from scratch.
 *  - On save, updates submittal_notes AND appends an audit row to
 *    `notes` (note_source='submittal_edit') so the activity feed keeps
 *    a per-edit trail.
 *  - Invalidates send-out + note query scopes so other surfaces
 *    refresh in lockstep.
 *
 * Sibling to `SendOutNotesDialog` — that one is a write-only collector
 * used at stage-move time.
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
  const [history, setHistory] = useState<NoteHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pull fresh notes every time the dialog opens. Loads both the
  // canonical submittal_notes column and the full audit trail in
  // parallel; falls back to the most-recent history row if the column
  // is empty (legacy "add to job" notes only landed in the trail).
  useEffect(() => {
    if (!open || !sendOutId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      supabase
        .from('send_outs')
        .select('submittal_notes')
        .eq('id', sendOutId)
        .maybeSingle(),
      supabase
        .from('notes')
        .select('id, note, created_at, note_source')
        .eq('entity_type', 'send_out')
        .eq('entity_id', sendOutId)
        .order('created_at', { ascending: false })
        .limit(20),
    ]).then(([soRes, notesRes]) => {
      if (cancelled) return;
      if (soRes.error) {
        toast({ title: 'Could not load notes', description: soRes.error.message, variant: 'destructive' });
      }
      const submittal = (soRes.data as any)?.submittal_notes ?? '';
      const trail = ((notesRes.data ?? []) as unknown as NoteHistoryRow[]);
      setHistory(trail);
      // Fall back to the most-recent history note if the canonical
      // column is empty — covers send-outs created before this dialog
      // existed where the only persisted note went to the audit table.
      const seed = submittal || trail[0]?.note || '';
      setNote(seed);
      setOriginal(submittal);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, sendOutId]);

  const handleSave = async () => {
    if (!sendOutId) return;
    setSaving(true);
    try {
      const { error: soErr } = await supabase
        .from('send_outs')
        .update({ submittal_notes: note })
        .eq('id', sendOutId);
      if (soErr) throw soErr;

      // Audit row — keeps the activity feed honest and gives us a
      // per-edit trail without bloating the canonical column.
      const trimmed = note.trim();
      if (trimmed) {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id ?? null;
        await supabase.from('notes').insert({
          entity_type: 'send_out',
          entity_id: sendOutId,
          note: trimmed,
          created_by: userId,
          note_source: 'submittal_edit',
        } as any);
      }
      invalidateSendOutScope(qc);
      invalidateNoteScope(qc);
      toast({ title: 'Notes saved' });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Could not save notes', description: err?.message || 'unknown error', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const subject = candidateName && jobTitle
    ? `${candidateName} → ${jobTitle}`
    : candidateName || jobTitle || '';

  const dirty = note !== original;

  // Don't show the seed note in the trail twice — when submittal_notes
  // was empty we promoted history[0] into the textarea.
  const trailToShow = original ? history : history.slice(1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send-out notes</DialogTitle>
          <DialogDescription>
            {subject
              ? <>Notes for <span className="font-medium">{subject}</span>.</>
              : <>Notes attached to this send-out.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="edit-send-out-note" className="text-xs uppercase tracking-wide text-muted-foreground">
            Current notes
          </Label>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <Textarea
              id="edit-send-out-note"
              autoFocus
              rows={5}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this candidate, what to flag for the client, comp expectations…"
              className="resize-y"
            />
          )}
        </div>

        {!loading && trailToShow.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-y-auto border-t pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              History
            </p>
            <div className="space-y-2">
              {trailToShow.map((h) => (
                <div key={h.id} className="rounded-md border border-card-border bg-secondary/30 p-2.5">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                    <span>{SOURCE_LABEL[h.note_source ?? ''] ?? 'Note'}</span>
                    <span>{format(new Date(h.created_at), 'MMM d, yyyy h:mm a')}</span>
                  </div>
                  <p className="text-xs whitespace-pre-wrap text-foreground">{h.note}</p>
                </div>
              ))}
            </div>
          </div>
        )}

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
